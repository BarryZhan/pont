import { PontSpec, PontJsonPointer } from "pont-spec";
import { InnerOriginConfig, PontInnerManagerConfig, PontPublicManagerConfig } from "./config";
import * as path from "path";
import * as fs from "fs-extra";
import { PontLogger, PontLoggerSpec } from "./logger";
import { lookForFiles } from "./scan";
import immutableSet from "lodash/fp/set";
import * as _ from "lodash";

const enhancedImmutableUpdate = (path: any[], updator, value) => {
  if (!path?.length) {
    return updator(value);
  }

  const [currentPath, ...restPaths] = path;
  if (typeof currentPath === "function") {
    const truePath = currentPath(value);

    return enhancedImmutableUpdate(restPaths, updator, _.get(value, truePath));
  }
};

const getSpecByName = (specs: PontSpec[], specName: string) => {
  return specs?.find((spec) => spec.name === specName) || specs?.[0];
};

export class PontManager {
  innerManagerConfig = new PontInnerManagerConfig();
  /** 本地使用的元数据 */
  localPontSpecs = [] as PontSpec[];
  /** 从远程更新的元数据 */
  remotePontSpecs = [] as PontSpec[];
  logger = new PontLogger();

  /** 当前管理的 originName */
  currentOriginName = "";

  static readonly lockFilename = "api-lock.json";
  static readonly configFilename = "pont-config.json";

  static checkIsSingleSpec(manager: PontManager) {
    return manager.innerManagerConfig.origins.length <= 1 && !manager.innerManagerConfig.origins?.[0]?.name;
  }

  static async constructorFromRootDir(rootDir: string, logger = new PontLogger()) {
    try {
      const configPathname = await lookForFiles(rootDir, PontManager.configFilename);

      if (configPathname) {
        const configContent = fs.readFileSync(configPathname, "utf8");
        let publicConfig = null;
        try {
          publicConfig = JSON.parse(configContent);
        } catch (e) {
          logger.error("您的 pont 配置文件不符合 JSON 格式: " + e.message);
          return;
        }

        let manager = new PontManager();
        manager.logger = logger;
        manager.innerManagerConfig = PontInnerManagerConfig.constructorFromPublicConfig(
          publicConfig,
          logger,
          path.resolve(configPathname, "../"),
        );

        manager = await PontManager.readLocalPontMeta(manager);
        manager = await PontManager.fetchRemotePontMeta(manager);

        const emptySpecs = [] as string[];
        // 自动用远程 spec，替换本地为空的 spec
        manager.localPontSpecs = manager.localPontSpecs.map((localSpec, specIndex) => {
          if (PontSpec.isEmptySpec(localSpec)) {
            emptySpecs.push(localSpec.name);
            const remoteSpec = manager.remotePontSpecs?.find((spec) => spec.name === localSpec.name);

            return remoteSpec || manager?.remotePontSpecs?.[specIndex] || localSpec;
          }

          return localSpec;
        });
        if (emptySpecs.length) {
          logger.info(`本地 ${emptySpecs.join(", ")} SDK为空，已为您自动生成...`);
          await PontManager.generateCode(manager);
        }

        return manager;
      } else {
        logger.error("未找到 Pont 配置文件");
      }
    } catch (e) {
      logger.error("Pont 创建失败:" + e.message, e.stack);
    }
  }

  static async constructorFromPontConfig(
    publicConfig: PontPublicManagerConfig,
    configPathname: string,
    logger = new PontLogger(),
  ) {
    try {
      let manager = new PontManager();
      manager.logger = logger;
      manager.innerManagerConfig = PontInnerManagerConfig.constructorFromPublicConfig(
        publicConfig,
        logger,
        path.resolve(configPathname, "../"),
      );

      manager = await PontManager.readLocalPontMeta(manager);
      manager = await PontManager.fetchRemotePontMeta(manager);

      // 自动用远程 spec，替换本地为空的 spec
      manager.localPontSpecs = manager.localPontSpecs.map((localSpec, specIndex) => {
        if (PontSpec.isEmptySpec(localSpec)) {
          const remoteSpec = manager.remotePontSpecs?.find((spec) => spec.name === localSpec.name);

          return remoteSpec || manager?.remotePontSpecs?.[specIndex] || localSpec;
        }

        return localSpec;
      });
      return manager;
    } catch (e) {
      logger.error("Pont 创建失败:" + e.message, e.stack);
    }
  }

  /** 读取本地 api-lock.json 文件 */
  static async privateReadLockFile(manager: PontManager) {
    const origins = manager.innerManagerConfig.origins;

    if (origins?.length === 1) {
      let lockFile = path.join(
        manager.innerManagerConfig.configDir,
        manager.innerManagerConfig.outDir,
        PontManager.lockFilename,
      );
      const isExists = fs.existsSync(lockFile);
      if (isExists) {
        const localDataStr = await fs.readFile(lockFile, {
          encoding: "utf8",
        });

        try {
          return [JSON.parse(localDataStr)];
        } catch (e) {
          manager.logger.error({
            processType: "read",
            message: "读取本地文件失败，文件内容不符合 JSON 规范。" + e.message,
          });
          return [new PontSpec()];
        }
      }
      return [new PontSpec()];
    } else {
      const allFilePromises = manager.innerManagerConfig.origins.map(async (config) => {
        const filePath = path.join(
          manager.innerManagerConfig.configDir,
          manager.innerManagerConfig.outDir,
          config.name,
          PontManager.lockFilename,
        );
        const isExists = fs.existsSync(filePath);
        if (isExists) {
          const localDataStr = await fs.readFile(filePath, {
            encoding: "utf8",
          });
          try {
            const spec = JSON.parse(localDataStr) as PontSpec;
            if (spec?.name === config.name) {
              return spec;
            }
          } catch (e) {
            manager.logger.error({
              originName: config.name,
              processType: "read",
              message: "读取本地文件失败，文件内容不符合 JSON 规范。" + e.message,
            });
          }
        }
        return PontSpec.constructorByName(config.name);
      });
      return Promise.all(allFilePromises);
    }
  }

  /** 流程方法：读取本地元数据 */
  static async readLocalPontMeta(manager: PontManager): Promise<PontManager> {
    const localSpecs = await this.privateReadLockFile(manager);
    // 重新排序
    const specs = localSpecs.map((spec) => {
      return PontSpec.reOrder(spec);
    });

    // 文件校验
    specs.forEach((spec) => {
      PontSpec.validateLock(spec).forEach((message) => {
        manager.logger.error({
          originName: spec.name,
          message,
          processType: "read",
        });
      });
    });

    return {
      ...manager,
      localPontSpecs: specs,
      currentOriginName: specs?.[0]?.name,
    };
  }

  /** 流程方法：拉取并解析远程元数据 */
  static async fetchRemotePontMeta(manager: PontManager): Promise<PontManager> {
    const remoteSpecPromises = manager.innerManagerConfig.origins.map(async (origin) => {
      const fetchPlugin = await Promise.resolve(origin.plugins.fetch.instance);
      const transformPlugin = await Promise.resolve(origin.plugins.transform?.instance);
      const metaStr = await fetchPlugin.apply(origin, origin.plugins.fetch.options);

      if (!metaStr) {
        // manager.logger.error("未获取到远程数据");
        return;
      }

      const parserPlugin = await Promise.resolve(origin.plugins.parser.instance);
      const spec = await parserPlugin.apply(metaStr, origin.name, origin.plugins.parser.options);
      const transformedSpec = (await transformPlugin?.apply(spec, origin.plugins.transform?.options)) || spec;
      if (!transformedSpec) {
        manager.logger.error("远程数据未解析成功！");
        return;
      }

      transformedSpec.name = origin.name || transformedSpec.name;

      return transformedSpec;
    });

    const remoteSpecs = await Promise.all(remoteSpecPromises);

    // 文件校验
    remoteSpecs.forEach((spec) => {
      if (spec) {
        PontSpec.validateLock(spec).forEach((message) => {
          manager.logger.error({
            originName: spec.name,
            message,
            processType: "parser",
          });
        });
      }
    });

    return {
      ...manager,
      remotePontSpecs: remoteSpecs.filter((spec) => spec),
    };
  }

  static async generateCode(manager: PontManager) {
    const generatorPlugin = await Promise.resolve(manager.innerManagerConfig.plugins.generate.instance);
    return Promise.resolve(generatorPlugin.apply(manager, manager.innerManagerConfig.plugins.generate.options));
  }

  // 展示方法
  static showDiffs(manager: PontManager) {}

  static syncMod(manager: PontManager, namespace: string, specName = "") {
    const remoteSpec = getSpecByName(manager.remotePontSpecs, specName);
    const remoteMod = PontSpec.getMods(remoteSpec)?.find((mod) => mod.name === namespace);

    if (remoteMod) {
      return PontJsonPointer.update(manager, `localPontSpecs[name=${specName}]`, (spec) =>
        PontSpec.updateMod(spec, remoteMod),
      );
    }

    return PontJsonPointer.update(manager, `localPontSpecs[name=${specName}]`, (spec) =>
      PontSpec.removeMod(spec, namespace),
    );
  }
  static syncBaseClass(manager: PontManager, baseClassName: string, specName = "") {
    const remoteSpec = getSpecByName(manager.remotePontSpecs, specName);
    const remoteClass = _.get(remoteSpec, `definitions.${baseClassName}`);

    if (remoteClass) {
      return PontJsonPointer.set(manager, `localPontSpecs[name=${specName}].definitions.${baseClassName}`, remoteClass);
    } else {
      return PontJsonPointer.remove(manager, `localPontSpecs[name=${specName}].definitions.${baseClassName}`);
    }
  }

  static syncInterface(manager: PontManager, apiName: string, modName: string, specName = "") {
    const remoteSpec = getSpecByName(manager.remotePontSpecs, specName);
    const remoteApi = remoteSpec?.apis?.[`${modName}/${apiName}`];

    if (remoteApi) {
      return PontJsonPointer.update(manager, `localPontSpecs[name=${specName}]`, (spec) => {
        const newSpec = PontJsonPointer.update(spec, `directories[namespace=${modName}].children`, (children) => {
          if ((children || []).find((child) => child === `${modName}/${remoteApi.name}`)) {
            return children;
          }
          return [...(children || []), `${modName}/${remoteApi.name}`];
        });
        return PontJsonPointer.set(newSpec, `apis[${modName}/${apiName}]`, remoteApi);
      });
    } else {
      return PontJsonPointer.update(manager, `localPontSpecs[name=${specName}]`, (spec) => {
        const newSpec = PontJsonPointer.update(spec, `directories[namespace=${modName}].children`, (children) => {
          if ((children || []).find((child) => child === `${modName}/${remoteApi.name}`)) {
            return children.filter((child) => child !== `${modName}/${remoteApi.name}`);
          }
          return children;
        });
        return PontJsonPointer.remove(newSpec, `apis[${modName}/${apiName}]`);
      });
    }
  }

  /** 流程方法：同步远程元数据 */
  static syncAll(manager: PontManager): PontManager {
    const localOriginIndex = manager.localPontSpecs?.findIndex((spec) => spec.name === manager.currentOriginName);
    const remoteOriginIndex = manager.remotePontSpecs?.findIndex((spec) => spec.name === manager.currentOriginName);

    if (remoteOriginIndex === -1) {
      manager.logger.error("远程数据源不存在!");
      return manager;
    }

    if (localOriginIndex !== -1) {
      return immutableSet(["localPontSpecs", localOriginIndex], manager.remotePontSpecs[remoteOriginIndex], manager);
    } else {
      const newLocalPontSpecs = [...manager.localPontSpecs, manager.remotePontSpecs[remoteOriginIndex]];
      return { ...manager, localPontSpecs: newLocalPontSpecs };
    }
  }

  /** 管理方法，切换当前管理的数据源 */
  static switchOriginName(manager: PontManager, originName: string): PontManager {
    if (manager.currentOriginName === originName) {
    } else if (!manager.innerManagerConfig.origins?.find((origin) => origin.name === originName)) {
    } else {
      return {
        ...manager,
        currentOriginName: originName,
      };
    }
  }

  static getSpec(manager: PontManager, specName?: string): PontSpec {
    return getSpecByName(manager.localPontSpecs, specName);
  }

  // 辅助方法
  static getCurrentSpec(manager: PontManager): PontSpec {
    return PontManager.getSpec(manager, manager.currentOriginName);
  }
}

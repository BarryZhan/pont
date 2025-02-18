import { PontSpec } from "pont-spec";
import { PontUIService } from "pont-ui";
import * as _ from "lodash";
import { vscode } from "./utils/utils";

if (import.meta.env.PROD) {
  const requestPostMessage = <T,>(message: { type: string; value?: any }): Promise<T> => {
    const requestId = _.uniqueId();
    vscode.postMessage({ ...message, requestId });

    return new Promise((resove, reject) => {
      window.addEventListener("message", (event) => {
        const responseMessage = event.data;
        if (responseMessage?.type === message.type && responseMessage?.requestId === requestId) {
          return resove(responseMessage.data as T);
        }
      });
    });
  };

  PontUIService.requestPontSpecs = () => {
    return requestPostMessage<{ localSpecs: PontSpec[]; remoteSpecs: PontSpec[]; currentOriginName: string }>({
      type: "requestPontSpecs",
    });
  };

  PontUIService.updateLocalSpec = (pontSpec: PontSpec) => {
    return requestPostMessage<void>({
      type: "updateLocalSpec",
      value: pontSpec,
    });
  };

  PontUIService.syncRemoteSpec = (specNames = "") => {
    return requestPostMessage<void>({
      type: "syncRemoteSpec",
      value: specNames,
    });
  };

  PontUIService.requestGenerateSdk = () => {
    return requestPostMessage<void>({
      type: "requestGenerateSdk",
    });
  };

  PontUIService.updateAPI = (modName: string, apiName: string, specName = "") => {
    return requestPostMessage<void>({
      type: "updateAPI",
      value: { modName, apiName, specName },
    });
  };

  PontUIService.updateBaseClass = (baseClassName: string, specName = "") => {
    return requestPostMessage<void>({
      type: "updateBaseClass",
      value: { baseClassName, specName },
    });
  };
}
// todo

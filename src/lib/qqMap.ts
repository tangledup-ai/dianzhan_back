/** 腾讯地图 JS SDK 共享加载器（MapPicker / StationMap 共用）
 *  key 从后端「系统设置」读取，未配置时使用打包内置默认值。
 */
import { loadMapKey } from "@/api/systemConfig";

let mapLoading = false;
let mapLoaded = false;

export function loadMapSDK(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (mapLoaded && (window as any).qq?.maps) {
      resolve();
      return;
    }
    if (mapLoading) {
      const check = setInterval(() => {
        if (mapLoaded && (window as any).qq?.maps) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      return;
    }
    mapLoading = true;
    (window as any).initQQMap = () => {
      mapLoaded = true;
      mapLoading = false;
      resolve();
    };
    loadMapKey()
      .then((key) => {
        const script = document.createElement("script");
        script.src = `https://map.qq.com/api/js?v=2.exp&key=${key}&callback=initQQMap`;
        script.async = true;
        script.onerror = () => {
          mapLoading = false;
          reject(new Error("地图SDK加载失败"));
        };
        document.head.appendChild(script);
      })
      .catch((e) => {
        mapLoading = false;
        reject(e);
      });
  });
}

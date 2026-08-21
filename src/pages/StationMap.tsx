import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getLandlordLocations } from "@/api/stations";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";

const MAP_KEY = "VS3BZ-TIXCV-RJ2PQ-5YUEE-UZDEV-MHFQD";

// 全局加载标记
let mapLoading = false;
let mapLoaded = false;

function loadMapSDK(): Promise<void> {
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
    const script = document.createElement("script");
    script.src = `https://map.qq.com/api/js?v=2.exp&key=${MAP_KEY}&callback=initQQMap`;
    script.async = true;
    script.onerror = () => {
      mapLoading = false;
      reject(new Error("地图SDK加载失败"));
    };
    document.head.appendChild(script);
  });
}

export default function StationMap() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const infoWindowRef = useRef<any>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: stations, isLoading, refetch } = useQuery({
    queryKey: ["landlordLocations", statusFilter],
    queryFn: () => getLandlordLocations(),
  });

  useEffect(() => {
    let destroyed = false;

    loadMapSDK().then(() => {
      if (destroyed || !mapRef.current || !(window as any).qq?.maps) return;

      const qq = (window as any).qq.maps;
      const center = new qq.LatLng(25.0389, 102.7183);
      const map = new qq.Map(mapRef.current, {
        center,
        zoom: 12,
        mapTypeId: qq.MapTypeId.ROADMAP,
      });

      mapInstanceRef.current = map;
    }).catch(console.error);

    return () => {
      destroyed = true;
    };
  }, []);

  useEffect(() => {
    if (mapInstanceRef.current && stations) {
      updateMarkers();
    }
  }, [stations]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateMarkers = () => {
    const map = mapInstanceRef.current;
    const qq = (window as any).qq?.maps;
    if (!map || !stations || !qq) return;

    // 清除旧标记
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    const validStations = stations.filter((s: any) => s.latitude && s.longitude);
    if (validStations.length === 0) return;

    const bounds = new qq.LatLngBounds();

    validStations.forEach((station: any) => {
      const position = new qq.LatLng(station.latitude, station.longitude);
      bounds.extend(position);

      const marker = new qq.Marker({
        position,
        map,
        title: station.name,
      });

      // 点击标记显示信息窗
      qq.event.addListener(marker, "click", () => {
        showInfoWindow(position, station);
      });

      markersRef.current.push(marker);
    });

    // 调整视野
    map.fitBounds(bounds);
  };

  const showInfoWindow = (position: any, station: any) => {
    const map = mapInstanceRef.current;
    const qq = (window as any).qq?.maps;
    if (!map || !qq) return;

    // 关闭旧的信息窗
    if (infoWindowRef.current) {
      infoWindowRef.current.close();
    }

    const statusColor = station.status === "运营中" ? "#dcfce7" : station.status === "筹建中" ? "#fef9c3" : "#fee2e2";
    const statusTextColor = station.status === "运营中" ? "#166534" : station.status === "筹建中" ? "#854d0e" : "#991b1b";

    const content = `
      <div style="padding: 10px; min-width: 200px;">
        <h3 style="font-weight: bold; margin-bottom: 8px;">${station.name}</h3>
        <p style="margin: 4px 0; color: #666;">编号: ${station.code || "-"}</p>
        <p style="margin: 4px 0; color: #666;">区域: ${station.region || "-"}</p>
        <p style="margin: 4px 0; color: #666;">地址: ${station.address || "-"}</p>
        <p style="margin: 4px 0;">
          <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; background: ${statusColor}; color: ${statusTextColor};">
            ${station.status}
          </span>
        </p>
      </div>
    `;

    const infoWindow = new qq.InfoWindow({
      map,
      position,
      content,
    });

    infoWindowRef.current = infoWindow;
  };

  const handleZoomIn = () => {
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setZoom(mapInstanceRef.current.getZoom() + 1);
    }
  };

  const handleZoomOut = () => {
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setZoom(mapInstanceRef.current.getZoom() - 1);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MapPin className="h-5 w-5 text-emerald-600" />
          <h1 className="text-lg font-semibold">场地地图</h1>
        </div>

        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder="状态筛选" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="运营中">运营中</SelectItem>
              <SelectItem value="筹建中">筹建中</SelectItem>
              <SelectItem value="已关停">已关停</SelectItem>
            </SelectContent>
          </Select>

          <Button variant="outline" size="icon" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="relative">
        <div ref={mapRef} className="h-[600px] w-full rounded-lg border border-slate-200" />

        <div className="absolute right-4 top-4 flex flex-col gap-2">
          <Button variant="outline" size="icon" onClick={handleZoomIn}>
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={handleZoomOut}>
            <ZoomOut className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-slate-500">
            {isLoading ? (
              "加载中..."
            ) : (
              <>
                共 <span className="font-semibold text-slate-700">{stations?.length || 0}</span> 个场地
                {statusFilter !== "all" && ` (筛选: ${statusFilter})`}
              </>
            )}
          </div>

          <div className="flex items-center gap-4 text-xs text-slate-500">
            <div className="flex items-center gap-1">
              <div className="h-3 w-3 rounded-full bg-green-500" />
              <span>运营中</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="h-3 w-3 rounded-full bg-yellow-500" />
              <span>筹建中</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="h-3 w-3 rounded-full bg-red-500" />
              <span>已关停</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

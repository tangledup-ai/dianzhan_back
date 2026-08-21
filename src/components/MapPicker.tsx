import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";

const MAP_KEY = "VS3BZ-TIXCV-RJ2PQ-5YUEE-UZDEV-MHFQD";

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

interface MapPickerProps {
  latitude?: number | null;
  longitude?: number | null;
  onLocationChange: (lat: number, lng: number) => void;
}

export function MapPicker({ latitude, longitude, onLocationChange }: MapPickerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const [currentLat, setCurrentLat] = useState<number | null>(latitude ?? null);
  const [currentLng, setCurrentLng] = useState<number | null>(longitude ?? null);

  useEffect(() => {
    let destroyed = false;

    loadMapSDK().then(() => {
      if (destroyed || !mapRef.current || !(window as any).qq?.maps) return;

      const qq = (window as any).qq.maps;
      const center = new qq.LatLng(latitude || 25.0389, longitude || 102.7183);

      const map = new qq.Map(mapRef.current, {
        center,
        zoom: 12,
        mapTypeId: qq.MapTypeId.ROADMAP,
      });

      qq.event.addListener(map, "click", (e: any) => {
        const lat = e.latLng.getLat();
        const lng = e.latLng.getLng();
        updateMarker(map, lat, lng);
        setCurrentLat(lat);
        setCurrentLng(lng);
        onLocationChange(lat, lng);
      });

      mapInstanceRef.current = map;

      if (latitude && longitude) {
        updateMarker(map, latitude, longitude);
      }
    }).catch(console.error);

    return () => {
      destroyed = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (latitude !== currentLat || longitude !== currentLng) {
      setCurrentLat(latitude ?? null);
      setCurrentLng(longitude ?? null);
      if (mapInstanceRef.current && latitude && longitude) {
        const qq = (window as any).qq.maps;
        updateMarker(mapInstanceRef.current, latitude, longitude);
        mapInstanceRef.current.panTo(new qq.LatLng(latitude, longitude));
      }
    }
  }, [latitude, longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateMarker = (map: any, lat: number, lng: number) => {
    const qq = (window as any).qq?.maps;
    if (!qq) return;

    if (markerRef.current) {
      markerRef.current.setMap(null);
    }

    const position = new qq.LatLng(lat, lng);
    const marker = new qq.Marker({
      position,
      map,
      animation: qq.MarkerAnimation.DROP,
    });

    markerRef.current = marker;
  };

  return (
    <div className="space-y-2">
      <div ref={mapRef} className="h-[300px] w-full rounded-lg border border-slate-200" />

      {currentLat && currentLng && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <MapPin className="h-3.5 w-3.5" />
          <span>坐标: {currentLat.toFixed(6)}, {currentLng.toFixed(6)}</span>
        </div>
      )}

      <p className="text-xs text-slate-400">点击地图选择站点位置</p>
    </div>
  );
}

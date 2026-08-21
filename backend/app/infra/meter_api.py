import httpx
import json
from datetime import datetime, timedelta
from ..config import TQ_API_URL, TQ_AUTH_CODE


class TQMeterClient:
    """天雀智慧电表 API 客户端（支持按账户传 URL/auth，默认回退全局 config）"""

    def __init__(self, base_url: str = None, auth_code: str = None):
        self.base_url = base_url or TQ_API_URL
        self.auth_code = auth_code or TQ_AUTH_CODE

    async def _request(self, method: str, path: str, **kwargs):
        """发送请求"""
        url = f"{self.base_url}{path}"
        params = kwargs.pop("params", {})
        params["auth"] = self.auth_code

        async with httpx.AsyncClient(timeout=30, verify=False) as client:
            resp = await client.request(method, url, params=params, **kwargs)
            resp.raise_for_status()
            return resp.json()

    def _extract_data(self, result, key="data"):
        """从响应中提取数据

        API 返回格式: {"status": 1, "total": 64, "data": [...]}
        失败时（如授权码错误）: {"status": 0, "msg": "...", ...} → 抛 ValueError
        """
        if isinstance(result, dict):
            if result.get("status") not in (1, None):
                raise ValueError(result.get("msg") or f"接口返回异常状态 {result.get('status')}")
            return result.get(key, [])
        if isinstance(result, list):
            return result
        return []

    # ─── 设备管理 ───────────────────────────────────────────

    async def get_devices(self) -> list:
        """获取设备列表（电表）"""
        result = await self._request("GET", "/Api/Meter")
        return self._extract_data(result)

    async def get_collectors(self) -> list:
        """获取采集器列表"""
        result = await self._request("GET", "/Api/Collector")
        return self._extract_data(result)

    # ─── 实时状态 ───────────────────────────────────────────

    async def get_status(self) -> list:
        """获取实时状态（总电量、尖峰平谷、剩余金额）"""
        result = await self._request("GET", "/Api/EleMeterState")
        return self._extract_data(result)

    # ─── 能耗统计 ───────────────────────────────────────────

    async def get_electricity_by_hour(self, start_time: str, end_time: str) -> dict:
        """电表能耗统计（小时维度）

        Args:
            start_time: 开始时间 YYYYMMDDHH
            end_time: 结束时间 YYYYMMDDHH
        """
        return await self._request("GET", "/Api/StatisticEle/hour", params={
            "start_time": start_time,
            "end_time": end_time,
        })

    async def get_electricity_by_day(self, start_time: str, end_time: str) -> dict:
        """电表能耗统计（日维度）

        Args:
            start_time: 开始日期 YYYYMMDD
            end_time: 结束日期 YYYYMMDD
        """
        return await self._request("GET", "/Api/StatisticEle/day", params={
            "start_time": start_time,
            "end_time": end_time,
        })

    async def get_electricity_by_month(self, start_month: str, end_month: str) -> dict:
        """获取月度用电量

        Args:
            start_month: 开始月份 YYYYMM
            end_month: 结束月份 YYYYMM
        """
        return await self._request("GET", "/Api/StatisticEle/month", params={
            "start_time": start_month,
            "end_time": end_month,
        })

    async def get_electricity_by_year(self, start_time: str, end_time: str) -> dict:
        """电表能耗统计（年维度）

        Args:
            start_time: 开始年份 YYYY
            end_time: 结束年份 YYYY
        """
        return await self._request("GET", "/Api/StatisticEle/year", params={
            "start_time": start_time,
            "end_time": end_time,
        })

    # ─── 历史数据 ───────────────────────────────────────────

    async def get_readings(self, start_time: str, end_time: str = None, meter_no: str = None) -> list:
        """获取历史抄表记录

        Args:
            start_time: 开始时间 YYYY-MM-DD HH:MM:SS
            end_time: 结束时间
            meter_no: 电表编号
        """
        params = {"start_time": start_time}
        if end_time:
            params["end_time"] = end_time
        if meter_no:
            params["address"] = meter_no
        result = await self._request("GET", "/Api/DataRequest", params=params)
        return self._extract_data(result)

    async def get_recharge_records(self, start_time: str, end_time: str = None) -> list:
        """查询充值记录

        Args:
            start_time: 开始时间 YYYY-MM-DD HH:MM:SS
            end_time: 结束时间
        """
        params = {"start_time": start_time}
        if end_time:
            params["end_time"] = end_time
        result = await self._request("GET", "/Api/Recharge", params=params)
        return self._extract_data(result)

    # ─── 报警 ──────────────────────────────────────────────

    async def get_warnings(self, device_type: int = 0) -> list:
        """获取报警信息

        Args:
            device_type: 设备类型 0=电表, 1=水表, 9=采集器
        """
        result = await self._request("GET", "/Api/Warning", params={"device_type": device_type})
        return self._extract_data(result)

    # ─── 档案 ──────────────────────────────────────────────

    async def get_users(self) -> list:
        """查询用户档案"""
        result = await self._request("GET", "/Api/User")
        return self._extract_data(result)

    async def get_prices(self) -> list:
        """查询价格档案"""
        result = await self._request("GET", "/Api/Price")
        return self._extract_data(result)


# 全局实例
tq_client = TQMeterClient()

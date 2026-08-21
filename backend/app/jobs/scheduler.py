from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

scheduler = AsyncIOScheduler()


def start_scheduler():
    """启动定时任务调度器"""
    from .sync_meters import (
        sync_devices, sync_collectors, sync_status,
        sync_hourly_data, sync_daily_data, sync_monthly_data, sync_yearly_data,
        sync_warnings,
    )

    # 设备列表 - 每6小时
    scheduler.add_job(sync_devices, IntervalTrigger(hours=6), id="sync_devices", replace_existing=True)

    # 采集器 - 每6小时
    scheduler.add_job(sync_collectors, IntervalTrigger(hours=6), id="sync_collectors", replace_existing=True)

    # 实时状态 - 每10分钟
    scheduler.add_job(sync_status, IntervalTrigger(minutes=10), id="sync_status", replace_existing=True)

    # 小时用电量 - 每小时
    scheduler.add_job(sync_hourly_data, IntervalTrigger(hours=1), id="sync_hourly", replace_existing=True)

    # 日用电量 - 每天凌晨2点
    scheduler.add_job(sync_daily_data, CronTrigger(hour=2, minute=0), id="sync_daily", replace_existing=True)

    # 月用电量 - 每天凌晨3点
    scheduler.add_job(sync_monthly_data, CronTrigger(hour=3, minute=0), id="sync_monthly", replace_existing=True)

    # 年用电量 - 每10天（月限额10次）
    scheduler.add_job(sync_yearly_data, IntervalTrigger(days=10), id="sync_yearly", replace_existing=True)

    # 报警信息 - 每2小时
    scheduler.add_job(sync_warnings, IntervalTrigger(hours=2), id="sync_warnings", replace_existing=True)

    scheduler.start()
    print("✅ 定时任务调度器已启动")
    print("  - 设备/采集器: 每6小时")
    print("  - 电表状态: 每10分钟")
    print("  - 小时用电量: 每小时")
    print("  - 日用电量: 每天凌晨2点")
    print("  - 月用电量: 每天凌晨3点")
    print("  - 年用电量: 每10天")
    print("  - 报警信息: 每2小时")


def stop_scheduler():
    """停止定时任务调度器"""
    if scheduler.running:
        scheduler.shutdown()
        print("⏹ 定时任务调度器已停止")


def get_scheduler_status():
    """获取调度器状态"""
    jobs = []
    for job in scheduler.get_jobs():
        jobs.append({
            "id": job.id,
            "nextRunTime": str(job.next_run_time) if job.next_run_time else None,
        })
    return {
        "running": scheduler.running,
        "jobs": jobs,
    }

@echo off
REM 开发环境启动脚本 (Windows)
REM 使用方法: dev.bat

echo 🚀 启动开发环境...

REM 检查 Docker 是否运行
docker info >nul 2>&1
if errorlevel 1 (
    echo ❌ 错误: Docker 未运行，请先启动 Docker Desktop
    pause
    exit /b 1
)

REM 停止可能正在运行的容器
echo 🛑 停止现有容器...
docker-compose -f docker-compose.dev.yml down

REM 启动后端和数据库（后台运行）
echo 🐘 启动 PostgreSQL 和 FastAPI 后端...
docker-compose -f docker-compose.dev.yml up -d

REM 等待后端启动
echo ⏳ 等待后端服务启动...
timeout /t 5 /nobreak >nul

REM 检查后端是否启动成功
curl -s http://localhost:3001/api/health >nul 2>&1
if errorlevel 1 (
    echo ⚠️  后端服务启动中...可能需要更多时间
) else (
    echo ✅ 后端服务启动成功 (http://localhost:3001)
)

REM 启动前端开发服务器
echo ⚛️  启动前端开发服务器...
echo 📍 前端地址: http://localhost:3000
echo 📍 后端地址: http://localhost:3001
echo.
echo 🎉 开发环境启动完成！
echo    - 修改前端代码: 浏览器自动刷新
echo    - 修改后端代码: 服务自动重启
echo.
echo 按 Ctrl+C 停止前端服务器
echo 后端服务会在后台继续运行
echo.

REM 启动前端开发服务器
npm run dev
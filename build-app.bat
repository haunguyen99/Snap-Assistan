@echo off
cd /d "%~dp0"
echo 🏗️ Building project...
npm run build
echo ✅ Build completed!
pause

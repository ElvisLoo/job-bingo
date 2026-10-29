@echo off
chcp 65001 >nul
title 面必过 (job_bingo)
cd /d "%~dp0"
echo 正在启动 面必过 / job_bingo ...
node toolsstart.js
if errorlevel 1 pause

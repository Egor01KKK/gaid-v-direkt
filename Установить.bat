@echo off
chcp 65001 >nul
rem «Гайд в директ» — установщик для Windows. Запуск: двойной клик.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\windows.ps1"

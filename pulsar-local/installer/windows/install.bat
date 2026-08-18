@echo off
:: ═══════════════════════════════════════════════════════════
::  Pulsar Live Agent — Windows 설치 시작
::  이 파일을 더블클릭하세요
:: ═══════════════════════════════════════════════════════════

title Pulsar Live Agent 설치
chcp 65001 >nul

cls
echo.
echo   Pulsar Live Agent 설치 시작...
echo.

:: PowerShell 실행 정책 확인 및 설치 스크립트 실행
powershell -NoProfile -ExecutionPolicy Bypass -Command "& { Start-Process PowerShell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%~dp0install.ps1""' -Wait -Verb RunAs }"

if errorlevel 1 (
    echo.
    echo   [오류] 설치 중 문제가 발생했습니다.
    echo   관리자 권한으로 다시 시도하거나,
    echo   PowerShell을 관리자 권한으로 열고
    echo   install.ps1 을 직접 실행해주세요.
    echo.
    pause
)

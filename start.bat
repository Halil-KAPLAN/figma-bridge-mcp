@echo off
cd /d "%~dp0"
echo Starting Figma Bridge MCP Server...
echo WebSocket: ws://localhost:3055
echo.
npm start
pause

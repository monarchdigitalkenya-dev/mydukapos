@echo off
title Cherish Healthcare - LAN chat server
cd /d "%~dp0"
echo.
echo  Starting the clinic LAN chat server. Keep this window open.
echo  (If Windows asks about the firewall, choose "Allow access" for Private networks.)
echo.
node lan-chat-server.mjs
pause

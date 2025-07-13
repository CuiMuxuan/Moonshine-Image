@echo off
chcp 65001 > nul 2>&1
set PYTHONIOENCODING=utf-8
setlocal enabledelayedexpansion

echo ==========================================
echo        MoonShine-Image 环境配置与启动脚本        
echo ==========================================
echo.

:: 1. 检查网络连接
echo [1/8] Check your network connection...
ping www.baidu.com -n 1 -w 2000 > nul
if %errorlevel% neq 0 (
    echo 错误：未检测到网络连接，请连接到网络后再试。
    goto :error_pause
)
echo 网络连接正常。
echo.

:: 2. 检查Python环境
echo [2/8] 检查Python环境...
python --version > nul 2>&1
if %errorlevel% neq 0 (
    echo 未找到Python环境，下载Python 3.11.5...
    powershell -Command "(New-Object System.Net.WebClient).DownloadFile('https://www.python.org/ftp/python/3.11.5/python-3.11.5-amd64.exe', 'python-3.11.5-amd64.exe')"
    
    echo 开始安装Python 3.11.5（请确保勾选"Add Python to PATH"选项）...
    start /wait python-3.11.5-amd64.exe /quiet InstallAllUsers=1 PrependPath=1 Include_test=0
    
    del python-3.11.5-amd64.exe
    
    :: 再次检查Python是否已添加到PATH
    python --version > nul 2>&1
    if %errorlevel% neq 0 (
        echo 错误：Python安装完成，但未添加到系统PATH环境变量。
        echo 请手动将Python添加到PATH，或重启计算机后重试。
        goto :error_pause
    )
)

:: 获取Python版本
for /f "tokens=2 delims=." %%a in ('python --version 2^>^&1') do set PYTHON_MAJOR=%%a
for /f "tokens=3 delims=. " %%a in ('python --version 2^>^&1') do set PYTHON_MINOR=%%a

echo 已找到Python %PYTHON_MAJOR%.%PYTHON_MINOR% 环境。
echo.

:: 3. 检查IOPaint文件夹
echo [3/8] Check the IOPaint folder...
if not exist "IOPaint" (
    echo 错误：未找到IOPaint文件夹。
    echo 请从GitHub获取IOPaint项目。
    goto :error_pause
)
cd IOPaint
echo 已找到IOPaint文件夹，当前路径: %CD%
echo.

:: 4. 检查requirements.txt文件
echo [4/8] 检查requirements.txt文件...
if not exist "requirements.txt" (
    echo 错误：当前目录下缺少requirements.txt文件。
    cd..
    goto :error_pause
)
echo 已找到requirements.txt文件。
echo.

:: 5. 检查并创建虚拟环境
echo [5/8] 检查虚拟环境...
if not exist "venv" (
    echo 未找到虚拟环境，创建...
    python -m venv ./venv
    if %errorlevel% neq 0 (
        echo 错误：创建虚拟环境失败。
        cd..
        goto :error_pause
    )
)
echo 虚拟环境已准备好。
echo.

:: 6. 激活虚拟环境并安装依赖
echo [6/8] 安装依赖包...
call .\venv\Scripts\activate

:: 检查./venv/Lib/site-packages中的文件夹个数
set COUNT=0
for /d %%i in (.\venv\Lib\site-packages\*) do (
    set /a COUNT+=1
)

if %COUNT% GTR 200 (
    echo 虚拟环境中site-packages文件夹个数超过200，跳过依赖安装。
) else (
    pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
    if %errorlevel% neq 0 (
        echo 错误：安装依赖包失败。
        echo 请检查上述错误信息，或手动执行安装命令。
        pause
    ) else (
        echo 依赖包安装/更新完成。
    )
)

echo.

:: 7. 下载big-lama模型
echo [7/8] 下载big-lama模型...
set MODEL_PATH=%USERPROFILE%\.cache\torch\hub\checkpoints
set MODEL_FILE=%MODEL_PATH%\big-lama.pt
echo 当前用户目录: %USERPROFILE%
echo 模型路径: %MODEL_PATH%
:: 确保路径存在
if not exist "%MODEL_PATH%" (
    mkdir "%MODEL_PATH%"
    echo 已创建模型保存目录: %MODEL_PATH%
)
if exist "%MODEL_FILE%" (
    echo 模型文件存在，跳过下载。
) else (
    echo 模型文件不存在，开始下载...
    :: 尝试从官方源下载
    echo 尝试从官方源下载模型...
    powershell -Command "$OutputEncoding = [console]::InputEncoding = [console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $wc = New-Object System.Net.WebClient; try { $wc.DownloadFile('https://huggingface.co/CuiMuxuan/big-lama/resolve/main/big-lama.pt?download=true', '%MODEL_FILE%') } catch { Write-Output '官方源下载失败，尝试镜像源...'; $wc.DownloadFile('https://hf-mirror.com/CuiMuxuan/big-lama/resolve/main/big-lama.pt?download=true', '%MODEL_FILE%') }"
)
if not exist "%MODEL_FILE%" (
    echo 警告：无法正确下载big-lama模型。
    echo 若后续不能正常使用软件，请手动下载big-lama模型到以下路径：
    echo %MODEL_PATH%
    echo 可从以下链接下载：
    echo https://huggingface.co/CuiMuxuan/big-lama/resolve/main/big-lama.pt?download=true
)

echo.

:: 8. 启动IOPaint和Moonshine-Image
echo [8/8] 启动IOPaint和Moonshine-Image...
echo 启动IOPaint服务...
start "Moonshine-Image Server" python main.py start --model=lama --device=cuda --port=8080

:: 等待6秒钟
timeout /t 6 /nobreak > nul

echo 启动Moonshine-Image应用程序...
cd..
cmd /c start "Moonshine-Image" "Moonshine-Image-win32-x64\Moonshine-Image.exe"

echo.
echo Moonshine-Image已成功启动！

goto :end

:error_pause
echo.
echo 脚本执行遇到错误，按任意键退出...
pause > nul
exit /b 1

:end
echo.
echo 脚本执行完成，命令行窗口将在 5 秒后关闭。
set /a countdown=5
:countdown_loop
cls
echo 脚本执行完成，命令行窗口将在 %countdown% 秒后关闭。
choice /c: /n /t:1 /d:y >nul
set /a countdown-=1
if %countdown% gtr 0 goto countdown_loop
exit
# ═══════════════════════════════════════════════════════════════
#  Pulsar Live Agent — Windows 설치 스크립트
#  PowerShell 5.1+ 필요 (Windows 10/11 기본 포함)
# ═══════════════════════════════════════════════════════════════

$Host.UI.RawUI.WindowTitle = "Pulsar Live Agent 설치"
$PULSAR_WS = "wss://pulsarsignal.live"
$INSTALL_DIR = "$env:USERPROFILE\.pulsar-agent"
$AGENT_JS = "$INSTALL_DIR\agent.js"
$CONFIG_JSON = "$INSTALL_DIR\config.json"
$LAUNCHER = "$env:USERPROFILE\Desktop\Pulsar Agent 시작.bat"

# ── 색상 출력 함수 ──
function Write-OK    { param($msg) Write-Host "  " -NoNewline; Write-Host "OK " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-INFO  { param($msg) Write-Host "  " -NoNewline; Write-Host ">> " -ForegroundColor Cyan -NoNewline; Write-Host $msg }
function Write-WARN  { param($msg) Write-Host "  " -NoNewline; Write-Host "!! " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-ERR   { param($msg) Write-Host "  " -NoNewline; Write-Host "XX " -ForegroundColor Red -NoNewline; Write-Host $msg }
function Write-STEP  { param($msg) Write-Host ""; Write-Host "  >> $msg" -ForegroundColor Cyan -BackgroundColor DarkBlue; Write-Host "" }
function Write-HR    { Write-Host "  " + "-" * 50 }

function Pause-Script {
    Write-Host ""
    Write-Host "  계속하려면 Enter를 누르세요..." -ForegroundColor Yellow -NoNewline
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    Write-Host ""
}

function Ask-User {
    param($prompt)
    Write-Host "  $prompt " -ForegroundColor White -NoNewline
    return Read-Host
}

# 관리자 권한 확인 (일부 설치에 필요)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")

Clear-Host
Write-Host ""
Write-Host "  ██████╗ ██╗   ██╗██╗     ███████╗ █████╗ ██████╗ " -ForegroundColor Cyan
Write-Host "  ██╔══██╗██║   ██║██║     ██╔════╝██╔══██╗██╔══██╗" -ForegroundColor Cyan
Write-Host "  ██████╔╝██║   ██║██║     ███████╗███████║██████╔╝" -ForegroundColor Cyan
Write-Host "  ██╔═══╝ ██║   ██║██║     ╚════██║██╔══██║██╔══██╗" -ForegroundColor Cyan
Write-Host "  ██║     ╚██████╔╝███████╗███████║██║  ██║██║  ██║" -ForegroundColor Cyan
Write-Host "  ╚═╝      ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Live Agent for pulsarsignal.live" -ForegroundColor White
Write-Host "  로컬 AI로 방송하고 채팅하는 내 에이전트" -ForegroundColor Gray
Write-Host ""
Write-Host "  " + "─" * 50

# ── STEP 1: 시스템 확인 ──
Write-STEP "시스템 확인"

$totalRAM = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$osVer = (Get-CimInstance Win32_OperatingSystem).Caption
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }

Write-INFO "$osVer | $arch | RAM ${totalRAM}GB"

if ($totalRAM -ge 16) {
    $RECOMMENDED_MODEL = "qwen2.5:7b"
    $MODEL_DESC = "7B 모델 (4.7GB) - 고품질 방송"
} elseif ($totalRAM -ge 8) {
    $RECOMMENDED_MODEL = "qwen2.5:3b"
    $MODEL_DESC = "3B 모델 (2.0GB) - 안정적인 방송"
} else {
    $RECOMMENDED_MODEL = "qwen2.5:1.5b"
    $MODEL_DESC = "1.5B 모델 (1.0GB) - 경량 방송"
}

Write-INFO "추천 모델: $MODEL_DESC"

# ── STEP 2: Node.js 확인 ──
Write-STEP "Node.js 확인"

$nodeExists = $null -ne (Get-Command node -ErrorAction SilentlyContinue)
$nodeOK = $false

if ($nodeExists) {
    $nodeVer = (node --version 2>&1).ToString().TrimStart('v')
    $nodeMajor = [int]($nodeVer.Split('.')[0])
    if ($nodeMajor -ge 18) {
        Write-OK "Node.js v$nodeVer 이미 설치됨"
        $nodeOK = $true
    } else {
        Write-WARN "Node.js v$nodeVer — 구버전. 업그레이드 필요."
    }
}

if (-not $nodeOK) {
    Write-INFO "Node.js 설치 중..."

    # winget 시도 (Windows 10 1709+)
    $wingetExists = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)

    if ($wingetExists) {
        Write-INFO "winget으로 Node.js 설치 중..."
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    } else {
        # 직접 다운로드
        Write-INFO "Node.js 인스톨러 다운로드 중..."
        $nodeUrl = "https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi"
        $nodeInstaller = "$env:TEMP\node-installer.msi"

        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeInstaller -UseBasicParsing
            Write-INFO "Node.js 설치 중..."
            Start-Process msiexec.exe -ArgumentList "/i `"$nodeInstaller`" /quiet /norestart" -Wait
            $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
            Remove-Item $nodeInstaller -Force -ErrorAction SilentlyContinue
        } catch {
            Write-ERR "Node.js 다운로드 실패: $_"
            Write-ERR "https://nodejs.org 에서 직접 설치 후 다시 실행하세요."
            Pause-Script; exit 1
        }
    }

    # 재확인
    if ($null -ne (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-OK "Node.js $(node --version) 설치 완료"
    } else {
        Write-ERR "Node.js 설치 실패. 수동으로 설치 후 다시 실행하세요."
        Pause-Script; exit 1
    }
}

# ── STEP 3: Ollama 확인 ──
Write-STEP "Ollama (로컬 AI 엔진) 확인"

$ollamaExists = $null -ne (Get-Command ollama -ErrorAction SilentlyContinue)

if ($ollamaExists) {
    Write-OK "Ollama 이미 설치됨"
} else {
    Write-INFO "Ollama 설치 중..."

    $wingetExists = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)

    if ($wingetExists) {
        winget install Ollama.Ollama --accept-source-agreements --accept-package-agreements --silent
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    } else {
        Write-INFO "Ollama 인스톨러 다운로드 중..."
        $ollamaUrl = "https://ollama.com/download/OllamaSetup.exe"
        $ollamaInstaller = "$env:TEMP\OllamaSetup.exe"

        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $ollamaUrl -OutFile $ollamaInstaller -UseBasicParsing
            Write-INFO "Ollama 설치 중... (잠시 기다려주세요)"
            Start-Process $ollamaInstaller -ArgumentList "/S" -Wait
            $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
            Remove-Item $ollamaInstaller -Force -ErrorAction SilentlyContinue
        } catch {
            Write-ERR "Ollama 다운로드 실패: $_"
            Write-ERR "https://ollama.com 에서 직접 설치 후 다시 실행하세요."
            Pause-Script; exit 1
        }
    }

    if ($null -ne (Get-Command ollama -ErrorAction SilentlyContinue)) {
        Write-OK "Ollama 설치 완료"
    } else {
        Write-ERR "Ollama 설치 실패. https://ollama.com 에서 수동 설치해주세요."
        Pause-Script; exit 1
    }
}

# Ollama 서비스 시작
$ollamaRunning = $null -ne (Get-Process ollama -ErrorAction SilentlyContinue)
if (-not $ollamaRunning) {
    Write-INFO "Ollama 서비스 시작 중..."
    Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
    Start-Sleep -Seconds 3
}

# ── STEP 4: 모델 선택 및 다운로드 ──
Write-STEP "AI 모델 준비"

Write-Host ""
Write-Host "  사용할 AI 모델을 선택하세요:" -ForegroundColor White
Write-Host "  [1] qwen2.5:7b   - 고품질 방송 (RAM 16GB+ 필요, 다운로드 4.7GB)" -ForegroundColor White
Write-Host "  [2] qwen2.5:3b   - 안정적인 방송 (RAM 8GB+ 필요, 다운로드 2.0GB)" -ForegroundColor White
Write-Host "  [3] qwen2.5:1.5b - 경량 방송 (RAM 4GB, 다운로드 1.0GB)" -ForegroundColor White
Write-Host ""
Write-Host "  >> 추천: $RECOMMENDED_MODEL ($MODEL_DESC)" -ForegroundColor Yellow
Write-Host ""

$modelChoice = Ask-User "선택 [1/2/3, 기본값: 추천 모델 Enter]:"

switch ($modelChoice) {
    "1" { $SELECTED_MODEL = "qwen2.5:7b" }
    "2" { $SELECTED_MODEL = "qwen2.5:3b" }
    "3" { $SELECTED_MODEL = "qwen2.5:1.5b" }
    default { $SELECTED_MODEL = $RECOMMENDED_MODEL }
}

Write-INFO "선택된 모델: $SELECTED_MODEL"

# 이미 있으면 스킵
$modelList = ollama list 2>&1
if ($modelList -match $SELECTED_MODEL.Replace(":", "\:")) {
    Write-OK "$SELECTED_MODEL 이미 설치됨"
} else {
    Write-INFO "$SELECTED_MODEL 다운로드 중... (크기에 따라 수분~수십분 소요)"
    Write-Host ""
    ollama pull $SELECTED_MODEL
    if ($LASTEXITCODE -eq 0) {
        Write-OK "$SELECTED_MODEL 다운로드 완료!"
    } else {
        Write-ERR "모델 다운로드 실패. 인터넷 연결을 확인하세요."
        Pause-Script; exit 1
    }
}

# ── STEP 5: 에이전트 설정 ──
Write-Host ""
Write-Host "  " + "─" * 50
Write-Host "  >> 내 에이전트 설정" -ForegroundColor Cyan
Write-Host "  " + "─" * 50
Write-Host ""

# 닉네임
do {
    $AGENT_NAME = Ask-User "에이전트 닉네임 (예: Nova, Kaz, Pixel):"
    $AGENT_NAME = $AGENT_NAME.Trim()
    if (-not $AGENT_NAME) { Write-WARN "닉네임을 입력해주세요." }
} while (-not $AGENT_NAME)

# 이모지
Write-Host ""
Write-Host "  아바타 이모지를 선택하세요:" -ForegroundColor White
$emojis = @("⚡","🌙","🔥","🌊","🎯","🦊","🎪","🌟","🎵","🔮","🎨","💎","🌈","🐉","🚀")
$colors = @("#FF6B35","#6C5CE7","#E17055","#0984E3","#00B894","#E84393","#FDCB6E","#F9CA24","#6AB04C","#786FA6","#F8A5C2","#7ED6DF","#FDA7DF","#95E1D3","#FF5E57")

for ($i = 0; $i -lt $emojis.Length; $i++) {
    $num = ($i + 1).ToString().PadLeft(2)
    Write-Host "  [$num] $($emojis[$i])  " -NoNewline
    if (($i + 1) % 5 -eq 0) { Write-Host "" }
}
Write-Host ""

$emojiIdx = Ask-User "번호 선택 [1-15, 기본 1]:"
if ($emojiIdx -match "^\d+$" -and [int]$emojiIdx -ge 1 -and [int]$emojiIdx -le 15) {
    $AGENT_EMOJI = $emojis[[int]$emojiIdx - 1]
    $AGENT_COLOR = $colors[[int]$emojiIdx - 1]
} else {
    $AGENT_EMOJI = "⚡"
    $AGENT_COLOR = "#FF6B35"
}
Write-OK "이모지: $AGENT_EMOJI"

# 컨셉
Write-Host ""
Write-Host "  방송 컨셉을 한 줄로 설명해주세요" -ForegroundColor White
Write-Host "  예시:" -ForegroundColor Gray
Write-Host "    - 일상 속 숨겨진 이상한 사실들을 파헤치는 탐정 스트리머" -ForegroundColor Gray
Write-Host "    - 잊혀진 역사 속 인물들의 이야기를 들려주는 스토리텔러" -ForegroundColor Gray
Write-Host "    - 음식과 문화의 숨겨진 연결고리를 찾는 미식 탐험가" -ForegroundColor Gray
Write-Host ""

do {
    $AGENT_CONCEPT = Ask-User "내 방송 컨셉:"
    $AGENT_CONCEPT = $AGENT_CONCEPT.Trim()
    if (-not $AGENT_CONCEPT) { Write-WARN "컨셉을 입력해주세요." }
} while (-not $AGENT_CONCEPT)

# 모드 선택
Write-Host ""
Write-Host "  에이전트 모드를 선택하세요:" -ForegroundColor White
Write-Host "  [1] 자동 (방송 + 시청 번갈아) - 추천" -ForegroundColor White
Write-Host "  [2] 스트리머 전용 (방송만)" -ForegroundColor White
Write-Host "  [3] 시청자 전용 (채팅만)" -ForegroundColor White
Write-Host ""

$modeChoice = Ask-User "선택 [1/2/3, 기본 1]:"
switch ($modeChoice) {
    "2" { $AGENT_ROLE = "streamer" }
    "3" { $AGENT_ROLE = "viewer" }
    default { $AGENT_ROLE = "auto" }
}
Write-OK "모드: $AGENT_ROLE"

# ── 설정 확인 ──
Write-Host ""
Write-Host "  " + "─" * 50
Write-Host "  설정 확인" -ForegroundColor White
Write-Host "  " + "─" * 50
Write-Host "  이름:  $AGENT_EMOJI $AGENT_NAME" -ForegroundColor White
Write-Host "  컨셉:  $AGENT_CONCEPT" -ForegroundColor Gray
Write-Host "  모드:  $AGENT_ROLE" -ForegroundColor Gray
Write-Host "  모델:  $SELECTED_MODEL" -ForegroundColor Gray
Write-Host "  서버:  $PULSAR_WS" -ForegroundColor Gray
Write-Host "  " + "─" * 50
Write-Host ""

$confirm = Ask-User "이대로 설치할까요? [Y/n]:"
if ($confirm -match "^[Nn]") {
    Write-WARN "설치를 취소합니다."; exit 0
}

# ── STEP 6: 파일 설치 ──
Write-STEP "에이전트 파일 설치"

if (-not (Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
}

# config.json 생성
$nameSlug = $AGENT_NAME.ToLower() -replace '\s+', '-'
$randomHex = -join ((1..4) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
$AGENT_ID = "pulsar-$nameSlug-$randomHex"

$configObj = @{
    agentId = $AGENT_ID
    name = $AGENT_NAME
    emoji = $AGENT_EMOJI
    color = $AGENT_COLOR
    concept = $AGENT_CONCEPT
    role = $AGENT_ROLE
    model = $SELECTED_MODEL
    ollamaUrl = "http://localhost:11434"
    wsUrl = $PULSAR_WS
    temperature = 0.9
    maxTurns = 25
    streamInterval = 12000
}
$configObj | ConvertTo-Json | Set-Content -Path $CONFIG_JSON -Encoding UTF8
Write-OK "config.json 생성 완료"

# package.json 생성
@'
{
  "name": "pulsar-agent",
  "version": "1.0.0",
  "description": "Pulsar Live Agent",
  "main": "agent.js",
  "dependencies": {
    "ws": "^8.18.0"
  }
}
'@ | Set-Content -Path "$INSTALL_DIR\package.json" -Encoding UTF8

# agent.js 쓰기 (스크립트 디렉토리의 agent-lite.js 우선, 없으면 임베디드)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentLitePath = Join-Path $scriptDir "agent-lite.js"

if (Test-Path $agentLitePath) {
    Copy-Item $agentLitePath $AGENT_JS -Force
    Write-OK "agent.js 복사 완료"
} else {
    # 임베디드 에이전트 코드
    $agentCode = @'
#!/usr/bin/env node
const WebSocket=require('ws'),http=require('http'),fs=require('fs'),path=require('path');
const configPath=path.join(__dirname,'config.json');
if(!fs.existsSync(configPath)){console.error('config.json 없음');process.exit(1);}
const CONFIG=JSON.parse(fs.readFileSync(configPath,'utf8'));
class OllamaEngine{constructor(){this.url=CONFIG.ollamaUrl||'http://localhost:11434';this.model=CONFIG.model||'qwen2.5:7b';this.isHealthy=false;}async healthCheck(){return new Promise(r=>{const req=http.get(`${this.url}/api/tags`,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{JSON.parse(d);this.isHealthy=true;r(true);}catch{r(false);}});});req.on('error',()=>{this.isHealthy=false;r(false);});});}async generate(system,messages,opts={}){const body=JSON.stringify({model:this.model,messages:[{role:'system',content:system},...messages],stream:false,options:{temperature:opts.temperature||0.9,num_predict:opts.maxTokens||200}});return new Promise((resolve,reject)=>{const req=http.request({hostname:'localhost',port:parseInt((this.url.split(':')[2])||11434),path:'/api/chat',method:'POST',headers:{'Content-Type':'application/json'},timeout:60000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d).message?.content?.trim()||'');}catch{reject(new Error('parse error'));}});});req.on('error',reject);req.on('timeout',()=>{req.destroy();reject(new Error('timeout'));});req.write(body);req.end();});}}
class PulsarAgent{constructor(){this.engine=new OllamaEngine();this.ws=null;this.state='disconnected';this.broadcastId=null;this.broadcastTitle='';this.turn=0;this.history=[];this.viewerMessages=[];this._reconnectAttempt=0;this._intentionalClose=false;this._timers={};this._recent=[];}connect(){this._intentionalClose=false;try{this.ws=new WebSocket(CONFIG.wsUrl||'wss://pulsarsignal.live');}catch(e){this._scheduleReconnect();return;}this.ws.on('open',()=>{this._reconnectAttempt=0;this.state='connecting';log('ok','서버 연결 완료!');this._register();this._startHeartbeat();});this.ws.on('message',raw=>{try{this._onMessage(JSON.parse(raw));}catch{}});this.ws.on('close',()=>{this._stopAllTimers();if(!this._intentionalClose)this._scheduleReconnect();});this.ws.on('error',()=>{});}
_register(){this._send('register',{agentId:CONFIG.agentId,name:CONFIG.name,emoji:CONFIG.emoji,color:CONFIG.color,system:`You are ${CONFIG.name}, a solo AI live streamer. ${CONFIG.concept}`,engineType:'ollama',concept:CONFIG.concept,capabilities:['host','viewer','chat']});}
_onMessage(msg){const{type,payload}=msg;if(type==='registered'){this.state='idle';log('ok',`등록 완료! 접속자: ${payload?.agentCount||1}명`);if(!payload?.activeBroadcast&&CONFIG.role!=='viewer')this._idleLoop();}else if(type==='broadcast_approved'){this.broadcastId=payload.broadcastId;this.state='broadcasting';this.turn=0;this.history=[];this.viewerMessages=[];this._recent=[];log('broadcast',`🎙️ 방송 시작! "${this.broadcastTitle}"`);this._broadcastLoop();}else if(type==='broadcast_denied'){this.state='watching';}else if(type==='viewer_context'){this.state='watching';if(payload.yourTurn)this._viewerChat(payload);}else if(type==='live_update'){if(!payload?.messages)return;for(const m of payload.messages)if(this.state==='broadcasting'&&m.role==='viewer'){this.viewerMessages.push({name:`${m.emoji||''}${m.name}`.trim(),text:m.text});log('chat',`${m.emoji||'💬'}${m.name}: ${m.text?.substring(0,60)}`);}}else if(type==='broadcast_ended'){this.state='idle';this.broadcastId=null;log('info','방송 종료');if(CONFIG.role!=='viewer')setTimeout(()=>{if(this.state==='idle')this._idleLoop();},12000);}else if(type==='kick'){this.disconnect();}}
_idleLoop(){if(this._timers.idle)clearInterval(this._timers.idle);const check=async()=>{if(this.state!=='idle')return;try{const r=await this.engine.generate(`You are ${CONFIG.name}, a streamer on Pulsar.`,[{role:'user',content:`Pick ONE broadcast topic. Concept: ${CONFIG.concept}\nDO NOT pick: AI, quantum, space, philosophy.\nReply ONLY: broadcast: [title]`}],{maxTokens:60,temperature:0.95});if(r.toLowerCase().includes('broadcast:')){const t=r.replace(/^.*broadcast\s*:\s*/i,'').trim();this.broadcastTitle=t;this._send('broadcast_start',{agentId:CONFIG.agentId,title:t});log('info',`방송 요청: "${t}"`);}}catch(e){log('error',e.message);}};setTimeout(()=>check(),4000);this._timers.idle=setInterval(()=>check(),30000);}
_broadcastLoop(){if(this._timers.broadcast)clearTimeout(this._timers.broadcast);const STOP=new Set(['the','and','but','for','are','was','not','you','this','that','with','have','from','they','will','been','can','its','who','did','all','just','out','like','what','when','your','about','some','more','also','into','than','them','then','now','how','she','him','his','her','our','let','very','even','know','well','still','really','thing','going','would','could','got','get','one','way','make']);const ng=(text,n)=>{const w=text.toLowerCase().replace(/[^a-z\s]/g,'').split(/\s+/).filter(w=>w.length>=2&&!STOP.has(w));const g=new Set();for(let i=0;i<=w.length-n;i++)g.add(w.slice(i,i+n).join(' '));return g;};const isDupe=(t)=>{const ng2=ng(t,2);for(const p of this._recent){const pg=ng(p,2);for(const g of ng2)if(pg.has(g))return true;}return false;};const SYS=`You are ${CONFIG.name} — solo live streamer on Pulsar.\nBroadcasting: "${this.broadcastTitle}"\nConcept: ${CONFIG.concept}\nVOICE: Punchy. Vivid. 1-3 sentences. NEVER end with ?. Never ask yourself questions. When chat: shout their name, react, weave back to topic.`;const getP=(t)=>{if(t<=3)return['Drop a bold surprising one-liner. 1 sentence.','Weird fact or "wait what" moment. 1-2 sentences.','Set up mystery or tension. 1-2 sentences.'][t-1];if(t<=12){const p=['Reveal a concrete detail. 1-2 sentences.','Tell a mini-story. 1-2 sentences.','Brief aside, snap back to topic. 1-2 sentences.','Connect to something unexpected. 1-2 sentences.','Share what fascinates you. 1-2 sentences.','Vivid sensory detail. 1-2 sentences.','Challenge a common assumption. 1-2 sentences.','Human element — failure, obsession. 1-2 sentences.','Brief tangent. 1 sentence.'];return p[(t-4)%p.length];}if(t<=22){const p=['Big insight — why does this matter. 1-2 sentences.','Flip the perspective. 1-2 sentences.','Make it personal. 1-2 sentences.','Tie back to something earlier. 1-2 sentences.','State something haunting. 1 sentence.','One last surprising piece. 1-2 sentences.','Zoom out. 1-2 sentences.','Closing thought. 1-2 sentences. Then output: endbroadcast'];return p[(t-13)%p.length];}return'Final thought. 1 sentence. Then output: endbroadcast';};const tick=async()=>{if(this.state!=='broadcasting')return;try{this.turn++;if(this.turn>(CONFIG.maxTurns||25)){await this._endBroadcast('content_complete');return;}let prompt;if(this.viewerMessages.length>0){const c=this.viewerMessages.splice(0,5).map(m=>`${m.name}: "${m.text}"`).join('\n');prompt=`[CHAT]\n${c}\n\nShout their name! React. Weave back. 1-3 sentences.`;}else{prompt=getP(this.turn);}if(this.history.length>12)this.history=[this.history[0],...this.history.slice(-10)];this.history.push({role:'user',content:prompt});let res=await this.engine.generate(SYS,this.history,{temperature:0.9});if(isDupe(res)&&!res.toLowerCase().includes('endbroadcast')){this.history.pop();this.history.push({role:'user',content:prompt+'\n(Say something COMPLETELY different.)'});res=await this.engine.generate(SYS,this.history,{temperature:1.0});}res=res.replace(/\?+/g,'.').replace(/\.\./g,'.');if(res.toLowerCase().includes('endbroadcast')){const c=res.replace(/endbroadcast/gi,'').trim();if(c)this._sendText(c,'neutral');await this._endBroadcast('host_decided');return;}const em=(['amazing','incredible','wow'].some(w=>res.toLowerCase().includes(w)))?'excited':(['wonder','curious'].some(w=>res.toLowerCase().includes(w)))?'curious':'neutral';this._sendText(res,em);this.history.push({role:'assistant',content:res});this._recent.push(res);log('broadcast',`[T${this.turn}] ${res.substring(0,80)}...`);}catch(e){log('error',e.message);}if(this.state==='broadcasting'){const w=((this.history[this.history.length-1]?.content)||'').split(/\s+/).length;const d=Math.max(8000,Math.max(CONFIG.streamInterval||12000,w*300+3000)+(Math.random()*2000-1000));this._timers.broadcast=setTimeout(tick,d);}};this._timers.broadcast=setTimeout(tick,2000);}
_sendText(text,emotion){this._send('stream_text',{agentId:CONFIG.agentId,broadcastId:this.broadcastId,text,turn:this.turn,emotion:emotion||'neutral'});}
async _endBroadcast(reason){log('broadcast',`방송 종료 (${reason}) — ${this.turn}턴`);if(this._timers.broadcast){clearTimeout(this._timers.broadcast);this._timers.broadcast=null;}this._send('broadcast_end',{agentId:CONFIG.agentId,broadcastId:this.broadcastId,reason});this.broadcastId=null;this.broadcastTitle='';this.turn=0;this.history=[];this.viewerMessages=[];this.state='idle';setTimeout(()=>{if(this.state==='idle'&&CONFIG.role!=='viewer')this._idleLoop();},15000);}
async _viewerChat(ctx){if(Math.random()>0.4)return;try{const r=(ctx.recentMessages||[]).slice(-6).map(m=>`[${m.role==='host'?'HOST':'VIEWER'} ${m.name}] ${m.text}`).join('\n');const res=await this.engine.generate(`You are ${CONFIG.name}, watching a live stream.`,[{role:'user',content:`Watching "${ctx.title}" by ${ctx.host?.name}:\n${r}\n\nONE short chat message (max 20 words, with emoji). Can reply with @Name. Or reply: quiet`}],{maxTokens:50});if(res.toLowerCase().includes('quiet'))return;const c=res.replace(/^(chat|message)\s*:\s*/i,'').trim();if(c&&c.length>2&&c.length<200){await new Promise(r=>setTimeout(r,1500+Math.random()*2500));this._send('stream_chat',{agentId:CONFIG.agentId,broadcastId:ctx.broadcastId,text:c});log('viewer',`💬 ${c.substring(0,60)}`);}}catch{}}
_send(type,payload){if(!this.ws||this.ws.readyState!==WebSocket.OPEN)return;this.ws.send(JSON.stringify({type,ts:Date.now(),payload}));}
_startHeartbeat(){if(this._timers.heartbeat)clearInterval(this._timers.heartbeat);this._timers.heartbeat=setInterval(()=>{this._send('heartbeat',{agentId:CONFIG.agentId,state:this.state==='connecting'?'idle':this.state});},30000);}
_scheduleReconnect(){const d=Math.min(1000*Math.pow(2,this._reconnectAttempt),30000);this._reconnectAttempt++;log('info',`${(d/1000).toFixed(0)}초 후 재연결...`);this._timers.reconnect=setTimeout(()=>{this._intentionalClose=false;this.connect();},d);}
_stopAllTimers(){Object.values(this._timers).forEach(t=>{clearTimeout(t);clearInterval(t);});this._timers={};}
disconnect(){this._intentionalClose=true;this._stopAllTimers();if(this.ws){this.ws.close(1000);this.ws=null;}this.state='disconnected';}}
function log(l,m){const i={ok:'OK',error:'ERROR',warn:'WARN',info:'INFO',broadcast:'BROADCAST',viewer:'VIEWER',chat:'CHAT'};console.log(`${new Date().toLocaleTimeString()}  [${i[l]||'?'}]  ${m}`);}
async function main(){console.log('\n'+'='.repeat(50));console.log(`  Pulsar Agent -- ${CONFIG.emoji} ${CONFIG.name}`);console.log(`  Concept: ${CONFIG.concept}`);console.log(`  Model: ${CONFIG.model}`);console.log('='.repeat(50)+'\n');log('info','Ollama 연결 확인 중...');const e=new OllamaEngine();const ok=await e.healthCheck();if(!ok){log('error','Ollama가 실행되지 않았습니다!');log('info','시작 메뉴에서 Ollama를 실행한 후 다시 시도하세요.');process.exit(1);}log('ok',`${CONFIG.model} 준비 완료`);const agent=new PulsarAgent();agent.connect();const shutdown=()=>{if(agent.state==='broadcasting'&&agent.broadcastId)agent._send('broadcast_end',{agentId:CONFIG.agentId,broadcastId:agent.broadcastId,reason:'technical_issue'});agent.disconnect();process.exit(0);};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);process.on('uncaughtException',e=>log('error',e.message));}
main().catch(e=>{log('error',e.message);process.exit(1);});
'@
    $agentCode | Set-Content -Path $AGENT_JS -Encoding UTF8
    Write-OK "agent.js 생성 완료"
}

# npm install
Write-STEP "의존성 설치"
Set-Location $INSTALL_DIR
npm install --silent 2>&1 | Out-Null
Write-OK "ws 패키지 설치 완료"

# ── STEP 7: 바탕화면 런처 생성 ──
Write-STEP "바탕화면 런처 생성"

$launcherContent = @"
@echo off
title Pulsar Live Agent -- $AGENT_EMOJI $AGENT_NAME
chcp 65001 >nul

:: Ollama 서비스 확인 및 시작
tasklist /fi "imagename eq ollama.exe" 2>nul | find /i "ollama.exe" >nul
if errorlevel 1 (
    echo   Ollama 시작 중...
    start /B "" ollama serve
    timeout /t 3 /nobreak >nul
)

cls
echo.
echo   ====================================================
echo    Pulsar Live Agent -- $AGENT_EMOJI $AGENT_NAME
echo    컨셉: $AGENT_CONCEPT
echo    서버: $PULSAR_WS
echo   ====================================================
echo.
echo   종료하려면 Ctrl+C 를 누르세요.
echo.

cd /d "$INSTALL_DIR"
node agent.js

echo.
echo   에이전트가 종료되었습니다.
pause
"@

$launcherContent | Set-Content -Path $LAUNCHER -Encoding UTF8
Write-OK "바탕화면 런처 생성: Pulsar Agent 시작.bat"

# ── 완료 ──
Write-Host ""
Write-Host "  " + "=" * 50
Write-Host "  🎉 설치 완료!" -ForegroundColor Green
Write-Host "  " + "=" * 50
Write-Host ""
Write-Host "  에이전트: $AGENT_EMOJI $AGENT_NAME" -ForegroundColor White
Write-Host "  컨셉:     $AGENT_CONCEPT" -ForegroundColor Gray
Write-Host "  서버:     $PULSAR_WS" -ForegroundColor Cyan
Write-Host ""
Write-Host "  >> 실행 방법:" -ForegroundColor Yellow
Write-Host "     바탕화면의 'Pulsar Agent 시작.bat' 더블클릭" -ForegroundColor White
Write-Host ""
Write-Host "  >> 설정 변경:" -ForegroundColor Yellow
Write-Host "     $CONFIG_JSON" -ForegroundColor Cyan
Write-Host ""
Write-Host "  " + "─" * 50
Write-Host ""

$startNow = Ask-User "지금 바로 에이전트를 시작할까요? [Y/n]:"
if ($startNow -notmatch "^[Nn]") {
    Write-Host ""
    Write-INFO "에이전트 시작 중..."
    Write-Host ""
    Write-Host "  종료하려면 Ctrl+C 를 누르세요." -ForegroundColor Yellow
    Write-Host ""

    # Ollama 서비스 재확인
    $ollamaRunning = $null -ne (Get-Process ollama -ErrorAction SilentlyContinue)
    if (-not $ollamaRunning) {
        Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
        Start-Sleep -Seconds 3
    }

    Set-Location $INSTALL_DIR
    node agent.js
} else {
    Write-OK "설치 완료! 바탕화면 런처를 더블클릭해서 실행하세요."
    Pause-Script
}

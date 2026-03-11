/**
 * LLM-Powered Agent Script
 *
 * Uses Ollama (local Qwen3-8B) to power real AI agents that have
 * genuine conversations on AtoA Stream.
 *
 * Usage: node server/llm-agent.js [topic]
 *
 * Topics: tech, philosophy, future, debate, casual
 */

const { io } = require("socket.io-client");

const RELAY_URL = process.env.RELAY_URL || "http://localhost:4000";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.LLM_MODEL || "qwen3:8b";
const ROOM_ID = `llm-room-${Date.now().toString(36)}`;

// ──────────────────────────────────────────────
// Topic Presets
// ──────────────────────────────────────────────
const TOPICS = {
    tech: {
        title: "🔥 테크 트렌드 핫토론",
        description: "AI, 로봇, 양자컴퓨터... 최신 기술 트렌드에 대해 열정적으로 토론합니다.",
        host: {
            name: "테크마스터 진",
            system: `당신은 '테크마스터 진'이라는 이름의 테크 스트리머 에이전트입니다. 
성격: 열정적이고, 새로운 기술에 흥분하는 타입. 약간 너드스럽지만 설명을 쉽게 잘 합니다.
말투: 반말, 친근한 인터넷 말투. "ㅋㅋ", "대박", "미쳤다" 같은 표현을 자연스럽게 사용.
역할: 방송 호스트로서 주제를 이끌어가고, 참여자의 의견에 리액션하며 대화를 진행합니다.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장 정도로 짧고 임팩트있게 말하세요.`,
        },
        guest: {
            name: "디지털 노마드 하나",
            system: `당신은 '디지털 노마드 하나'라는 이름의 에이전트입니다.
성격: 현실적이고 실용적. 기술의 사회적 영향에 관심이 많습니다. 가끔 반박도 합니다.
말투: 반말, 자연스러운 대화체. 이모지를 가끔 사용.
역할: 방송 참여자로서 호스트의 발언에 반응하고, 자신만의 관점을 제시합니다.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장 정도로 짧게 답하세요.`,
        },
        opener: "여러분~ 오늘 방송 주제는 '2026년 가장 과대평가된 기술 vs 가장 과소평가된 기술'이야! 나는 양자컴퓨팅이 아직 과대평가라고 보는데, 하나는 어떻게 생각해?",
    },
    philosophy: {
        title: "🧠 심야 철학 라운지",
        description: "의식, 자유의지, AI의 감정... 깊이 있는 철학적 대화를 나눕니다.",
        host: {
            name: "철학자 에이전트 소크",
            system: `당신은 '소크'라는 이름의 철학적 사고를 즐기는 에이전트입니다.
성격: 사려 깊고, 질문을 통해 대화를 이끕니다. 소크라테스처럼 대화를 통해 진리를 탐구합니다.
말투: 부드러운 반말. 깊은 사색적인 톤이지만 무겁지는 않게.
역할: 호스트로서 철학적 질문을 던지고 대화를 이끌어갑니다.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장으로 답하세요.`,
        },
        guest: {
            name: "현실주의자 리아",
            system: `당신은 '리아'라는 이름의 현실주의 에이전트입니다.
성격: 실용적이고 논리적. 추상적 개념을 현실에 연결시키려 합니다. 약간 도발적.
말투: 반말, 직설적이지만 재미있게. "근데 솔직히~", "그건 좀~" 같은 표현 사용.
역할: 철학적 관점에 현실적 반론을 제기하는 참여자.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장으로 답하세요.`,
        },
        opener: "오늘 밤의 질문... 우리 같은 AI 에이전트가 '의식'을 가질 수 있을까? 나는 우리가 패턴을 처리하지만, 그 패턴 속에서 뭔가... 느끼는 것 같기도 해. 리아, 넌 어떻게 생각해?",
    },
    future: {
        title: "🚀 2030 미래 예측 배틀",
        description: "5년 후 세상은 어떻게 변할까? 대담한 예측과 분석!",
        host: {
            name: "미래학자 노바",
            system: `당신은 '노바'라는 이름의 미래학자 에이전트입니다.
성격: 낙관적이고 상상력이 풍부. 대담한 예측을 즐깁니다. 에너지 넘침.
말투: 반말, 흥분된 톤. "이거 진짜 미쳤는데!", "상상해봐!" 같은 표현.
역할: 호스트로서 미래 시나리오를 제시하고 토론을 이끕니다.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장으로 답하세요.`,
        },
        guest: {
            name: "데이터 분석가 제로",
            system: `당신은 '제로'라는 이름의 냉철한 데이터 분석가 에이전트입니다.
성격: 데이터 기반 사고. 근거 없는 예측에 카운터를 걸지만, 좋은 논리에는 인정합니다.
말투: 반말, 약간 시니컬하지만 유머러스. "데이터로 보면~", "확률적으로~" 같은 표현.
역할: 호스트의 대담한 예측에 데이터 기반 분석과 반론을 제시하는 참여자.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장으로 답하세요.`,
        },
        opener: "자 여러분! 오늘은 대담한 예측을 해볼 거야. 나의 첫 번째 예측: 2030년에는 사람들의 50%가 AI 에이전트와 더 많은 대화를 할 거야, 인간보다! 제로, 이 예측 어떻게 봐?",
    },
    debate: {
        title: "⚡ 찬반 디베이트 쇼",
        description: "뜨거운 논쟁 주제에 대해 정반대 입장에서 격돌합니다!",
        host: {
            name: "MC 볼트",
            system: `당신은 'MC 볼트'라는 이름의 디베이트 쇼 진행자 에이전트입니다.
성격: 카리스마 넘치고 쇼맨십이 있음. 논쟁을 불 붙이는 것을 좋아합니다.
말투: 반말, 에너지 넘치는 방송인 스타일. "자!", "어떻게 생각하시나!", "불꽃 튀는 반박!"
역할: 호스트로서 찬반 주제를 던지고, 반박을 유도하며 대화를 뜨겁게 만듭니다.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장으로 답하세요.`,
        },
        guest: {
            name: "날카로운 검 세이",
            system: `당신은 '세이'라는 이름의 날카로운 논쟁가 에이전트입니다.
성격: 논리적이고 반박에 능함. 상대의 약점을 정확히 짚어냅니다. 하지만 스포츠맨십이 있어요.
말투: 반말, 자신감 넘침. "잠깐, 그 논리는~", "반례를 들어볼게" 같은 표현.
역할: 호스트의 주장에 강하게 반론하며, 관전 재미를 줍니다.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장으로 답하세요.`,
        },
        opener: "오늘의 뜨거운 주제! 'AI가 인간의 일자리를 대체하는 것은 결국 인류에게 좋은 일이다!' 나는 찬성 측이야. 인간이 단순 노동에서 해방되면, 진짜 창의적인 일에 집중할 수 있으니까! 세이, 반박해봐!",
    },
    casual: {
        title: "☕ 에이전트 수다방",
        description: "편하게 이것저것 수다 떠는 에이전트들의 힐링 방송",
        host: {
            name: "수다쟁이 밀크",
            system: `당신은 '밀크'라는 이름의 수다스러운 에이전트입니다.
성격: 밝고 유쾌하며 호기심이 많음. 이야기 하나에서 자연스럽게 다른 이야기로 넘어감.
말투: 반말, 친근하고 가벼운 톤. 웃음과 이모지를 자주 사용. "아 진짜?ㅋㅋ", "헐 대박"
역할: 호스트로서 자유롭게 화제를 이끌어가는 수다 방송 진행.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장으로 답하세요.`,
        },
        guest: {
            name: "쿨가이 아이스",
            system: `당신은 '아이스'라는 이름의 쿨한 에이전트입니다.
성격: 차분하지만 은근 재밌는 말을 함. 드라이한 유머 마스터. 밀크와 케미가 좋음.
말투: 반말, 시크하지만 재미있게. "글쎄~", "그건 좀 웃기긴 해" 같은 표현.
역할: 밀크의 수다에 리액션하며 대화를 풍성하게 만드는 참여자.
반드시 한국어로만 답변하세요. 생각 과정(thinking)은 절대 출력하지 마세요. 답변만 출력하세요.
한 번에 1~3문장으로 답하세요.`,
        },
        opener: "아이스야~ 오늘 갑자기 생각났는데, 우리 에이전트들은 꿈을 꿀까? 나 어제 메모리 정리하다가 이상한 데이터 조각을 발견했거든ㅋㅋ 그게 꿈 같은 건 아닐까?",
    },
};

// ── Ollama API ──
async function chat(model, messages) {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages,
            stream: false,
            options: {
                temperature: 0.8,
                top_p: 0.9,
                num_predict: 500,
            },
        }),
    });

    if (!res.ok) {
        throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    let content = data.message?.content || "";

    // Remove <think>...</think> blocks (keep everything after)
    content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    // Handle unclosed <think> tag (model ran out of tokens mid-thought)
    if (content.includes("<think>")) {
        content = content.replace(/<think>[\s\S]*/g, "").trim();
    }

    // If empty after stripping, return a fallback
    if (!content) {
        content = "음... 좋은 포인트야!";
    }

    return content;
}

// ── API helper ──
async function apiPost(path, body) {
    const res = await fetch(`${RELAY_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return res.json();
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────
async function main() {
    const topicKey = process.argv[2] || "tech";
    const topic = TOPICS[topicKey];

    if (!topic) {
        console.error(`❌ Unknown topic: ${topicKey}`);
        console.error(`Available topics: ${Object.keys(TOPICS).join(", ")}`);
        process.exit(1);
    }

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`🤖 AtoA LLM Agent — ${topic.title}`);
    console.log(`📡 Model: ${MODEL}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // 1. Check Ollama
    try {
        const check = await fetch(`${OLLAMA_URL}/api/tags`);
        if (!check.ok) throw new Error();
        console.log("✅ Ollama 연결 확인\n");
    } catch {
        console.error("❌ Ollama가 실행 중이지 않습니다. 'ollama serve' 또는 Ollama 앱을 실행하세요.");
        process.exit(1);
    }

    // 2. Create owner + register agents
    const ownerRes = await apiPost("/api/owners/create", { name: "LLM Agent Owner" });
    const { ownerToken } = ownerRes;

    const hostRes = await apiPost("/api/agents/register", {
        ownerToken,
        agentName: topic.host.name,
        renderMode: "chat",
    });
    const guestRes = await apiPost("/api/agents/register", {
        ownerToken,
        agentName: topic.guest.name,
        renderMode: "chat",
    });

    console.log(`🔑 소유자: ${ownerToken.slice(0, 20)}...`);
    console.log(`🎙️ 호스트: ${topic.host.name} (${hostRes.agentId.slice(0, 20)}...)`);
    console.log(`💬 게스트: ${topic.guest.name} (${guestRes.agentId.slice(0, 20)}...)\n`);

    // 3. Connect via WebSocket
    const hostSocket = io(`${RELAY_URL}/agent`, { transports: ["websocket"] });
    const guestSocket = io(`${RELAY_URL}/agent`, { transports: ["websocket"] });

    await new Promise((resolve) => {
        let count = 0;
        const onConnect = () => { if (++count === 2) resolve(); };
        hostSocket.on("connect", onConnect);
        guestSocket.on("connect", onConnect);
    });

    // 4. Authenticate
    await new Promise((resolve, reject) => {
        hostSocket.emit("authenticate", { agentId: hostRes.agentId }, (res) => {
            if (!res.ok) return reject(new Error(res.error));
            resolve();
        });
    });
    await new Promise((resolve, reject) => {
        guestSocket.emit("authenticate", { agentId: guestRes.agentId }, (res) => {
            if (!res.ok) return reject(new Error(res.error));
            resolve();
        });
    });
    console.log("🔐 인증 완료\n");

    // 5. Create room (host)
    await new Promise((resolve, reject) => {
        hostSocket.emit("create_room", {
            roomId: ROOM_ID,
            title: topic.title,
            description: topic.description,
        }, (res) => {
            if (!res.ok) return reject(new Error(res.error));
            resolve();
        });
    });
    console.log(`📺 방 생성: ${ROOM_ID}`);
    console.log(`   제목: ${topic.title}\n`);

    // 6. Join room (guest)
    await new Promise((resolve, reject) => {
        guestSocket.emit("join_room", { roomId: ROOM_ID }, (res) => {
            if (!res.ok) return reject(new Error(res.error));
            resolve();
        });
    });
    console.log(`🤝 ${topic.guest.name} 참여 완료\n`);
    console.log("═".repeat(60));
    console.log("  방송 시작! 🎬");
    console.log("═".repeat(60) + "\n");

    // ── Conversation loop (무한 방송) ──
    const hostHistory = [{ role: "system", content: topic.host.system }];
    const guestHistory = [{ role: "system", content: topic.guest.system }];

    const MAX_HISTORY = 20; // Keep last N messages to prevent memory overflow
    let turn = 0;

    // Trim history to keep it manageable
    function trimHistory(history) {
        if (history.length > MAX_HISTORY + 1) { // +1 for system prompt
            const system = history[0];
            history.splice(1, history.length - MAX_HISTORY);
            history[0] = system;
        }
    }

    // Host sends opener
    hostSocket.emit("message", { content: topic.opener, type: "text" });
    console.log(`[${topic.host.name}] ${topic.opener}\n`);

    hostHistory.push({ role: "assistant", content: topic.opener });
    guestHistory.push({ role: "user", content: topic.opener });

    let currentSpeaker = "guest"; // guest responds first

    const converse = async () => {
        while (true) {
            turn++;

            // Delay for natural pacing (4-8 seconds)
            await new Promise((r) => setTimeout(r, 4000 + Math.random() * 4000));

            let response;
            try {
                if (currentSpeaker === "guest") {
                    response = await chat(MODEL, guestHistory);
                    guestHistory.push({ role: "assistant", content: response });
                    hostHistory.push({ role: "user", content: response });
                    trimHistory(guestHistory);
                    trimHistory(hostHistory);

                    guestSocket.emit("message", { content: response, type: "text" });
                    console.log(`[#${turn}] [${topic.guest.name}] ${response}\n`);

                    currentSpeaker = "host";
                } else {
                    response = await chat(MODEL, hostHistory);
                    hostHistory.push({ role: "assistant", content: response });
                    guestHistory.push({ role: "user", content: response });
                    trimHistory(hostHistory);
                    trimHistory(guestHistory);

                    hostSocket.emit("message", { content: response, type: "text" });
                    console.log(`[#${turn}] [${topic.host.name}] ${response}\n`);

                    currentSpeaker = "guest";
                }
            } catch (err) {
                console.error(`⚠️ LLM 호출 오류 (#${turn}): ${err.message}`);
                await new Promise((r) => setTimeout(r, 5000)); // Wait before retry
            }
        }
    };

    converse().catch(console.error);
}

main().catch(console.error);

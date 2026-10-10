:root {
    --bg-dark: #101319;
    --panel-bg: #171b24;
    --card-bg: #1f2533;
    --border-color: #2b3347;
    --text-main: #e2e8f0;
    --text-muted: #8493a8;
    
    --accent: #00e676;
    --accent-blue: #2979ff;
    --accent-gold: #ffb300;
    --accent-red: #ff3d00;
    
    /* ЦВЕТА ПОДСВЕТКИ СИНТАКСИСА */
    --syn-op: #38bdf8;     /* Синий: команды (ldi, mov, add) */
    --syn-com: #4ade80;    /* Зелёный: комментарии (; text) */
    --syn-lbl: #fb923c;    /* Оранжевый: метки (m:, loop:) */
    --syn-dir: #c084fc;    /* Фиолетовый: директивы (.include) */
    --syn-num: #fcd34d;    /* Жёлтый: константы и числа */
    
    --font-mono: 'Consolas', 'Courier New', monospace;
    --font-ui: system-ui, -apple-system, sans-serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--bg-dark);
    color: var(--text-main);
    font-family: var(--font-ui);
    user-select: none;
}

.app-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
}

/* ================= 1. ШАПКА ================= */
.toolbar {
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
    padding: 6px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-shrink: 0;
    z-index: 100;
}

.toolbar-left { display: flex; align-items: center; gap: 10px; }
.logo { font-size: 1em; font-weight: 800; color: #fff; white-space: nowrap; }
.logo span { color: var(--accent); }

.select-wrapper select {
    background: var(--card-bg);
    color: #fff;
    border: 1px solid var(--border-color);
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 0.85em;
    outline: none;
    cursor: pointer;
    max-width: 260px;
}

.toolbar-center { display: flex; align-items: center; gap: 6px; }
.btn {
    background: var(--card-bg);
    color: #fff;
    border: 1px solid var(--border-color);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.82em;
    display: flex;
    align-items: center;
    gap: 5px;
    transition: transform .1s ease;
}
.btn:hover { border-color: var(--text-muted); }
.btn-step { background: rgba(41, 121, 255, 0.2); border-color: var(--accent-blue); color: #90caf9; }
.btn-run { background: rgba(0, 230, 118, 0.2); border-color: var(--accent); color: #b9f6ca; }
.btn-run.running { background: rgba(255, 61, 0, 0.2); border-color: var(--accent-red); color: #ffab91; }
.btn-reset { color: var(--text-muted); }

.speed-box {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.78em;
    color: var(--text-muted);
}
.speed-box input[type="range"] {
    width: 60px;
    accent-color: var(--accent);
    cursor: pointer;
}

.nav-screens {
    display: flex;
    gap: 4px;
    background: rgba(0,0,0,0.3);
    padding: 3px;
    border-radius: 8px;
    border: 1px solid var(--border-color);
}
.nav-screen-btn {
    background: transparent;
    border: none;
    color: var(--text-muted);
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 0.82em;
    font-weight: 700;
    cursor: pointer;
    transition: all .2s;
    white-space: nowrap;
}
.nav-screen-btn.active {
    background: var(--accent-blue);
    color: #fff;
    box-shadow: 0 2px 8px rgba(41, 121, 255, 0.4);
}

/* ================= 2. ПЛАШКА-ПОДСКАЗКА ================= */
.hint-banner {
    background: rgba(41, 121, 255, 0.08);
    border-bottom: 1px solid rgba(41, 121, 255, 0.2);
    padding: 6px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.82em;
    color: #cbd5e1;
    flex-shrink: 0;
}
.hint-icon { font-size: 1.1em; }
.hint-text b { color: var(--accent-gold); }

/* ================= 3. СЛАЙДЕР ================= */
.slider-viewport {
    flex: 1;
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    scroll-behavior: smooth;
    -webkit-overflow-scrolling: touch;
}
.slider-viewport::-webkit-scrollbar { display: none; }

.slider-track {
    display: flex;
    width: 300%;
    height: 100%;
}

.slide-panel {
    flex: 0 0 33.333333%;
    width: 33.333333%;
    height: 100%;
    scroll-snap-align: start;
    display: flex;
    flex-direction: column;
    background: var(--panel-bg);
    border-right: 1px solid var(--border-color);
    overflow: hidden;
}

.slide-header {
    background: rgba(255,255,255,0.02);
    border-bottom: 1px solid var(--border-color);
    padding: 8px 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
}
.slide-header h2 { font-size: 0.9em; font-weight: 700; color: #fff; }
.editor-status { font-size: 0.78em; color: var(--text-muted); display: flex; gap: 10px; }

/* ================= ЭКРАН 1: РЕДАКТОР С ПОДСВЕТКОЙ ================= */
.editor-wrapper {
    flex: 1;
    display: flex;
    background: #0b0d13;
    overflow: hidden;
    position: relative;
}
.line-numbers {
    width: 38px;
    padding: 10px 4px;
    text-align: right;
    font-family: var(--font-mono);
    font-size: 0.88em;
    color: #4b5563;
    background: #08090d;
    user-select: none;
    line-height: 1.5;
    border-right: 1px solid #1a1e28;
    z-index: 5;
}

.editor-container {
    flex: 1;
    position: relative;
    overflow: hidden;
}

/* Синхронизированный слой подсветки и слой ввода */
pre#highlighting, textarea#asmCode {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 0.88em;
    line-height: 1.5;
    white-space: pre;
    tab-size: 4;
    border: none;
    outline: none;
}

/* Прозрачный textarea для ввода текста */
textarea#asmCode {
    background: transparent;
    color: transparent;
    caret-color: #fff;
    resize: none;
    z-index: 2;
    user-select: text;
}

/* Цветной слой под текстом */
pre#highlighting {
    background: transparent;
    color: #e2e8f0;
    overflow: hidden;
    pointer-events: none;
    z-index: 1;
}

/* СТИЛИ СИНТАКСИСА */
.syn-op { color: var(--syn-op); font-weight: 700; }
.syn-com { color: var(--syn-com); font-style: italic; }
.syn-lbl { color: var(--syn-lbl); font-weight: 700; }
.syn-dir { color: var(--syn-dir); }
.syn-num { color: var(--syn-num); }

/* ================= ЭКРАН 2: ПЛАТА ================= */
.board-scroll-area {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.board-card {
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 12px;
}
.card-title { font-size: 0.85em; font-weight: 700; color: #fff; margin-bottom: 6px; }
.board-note { font-size: 0.75em; color: var(--text-muted); margin-bottom: 8px; }

/* КНОПКИ С ФИКСАЦИЕЙ */
.btn-matrix { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.v-btn {
    background: #151922; border: 2px solid #334155; color: #e2e8f0;
    padding: 12px 6px; border-radius: 8px; font-size: 0.82em; font-weight: 800;
    cursor: pointer; transition: all .15s ease; display: flex; flex-direction: column;
    align-items: center; gap: 2px;
}
.v-btn span { font-size: 0.68em; font-weight: 400; color: var(--text-muted); }
.v-btn.latched {
    background: var(--accent-gold); color: #000; border-color: #fff;
    transform: scale(0.96); box-shadow: 0 0 14px rgba(255, 179, 0, 0.6);
}
.v-btn.latched span { color: #332200; font-weight: 700; }

/* Переключатель портов светодиодов */
.port-header-row {
    display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;
}
.port-selector-btns { display: flex; gap: 4px; }
.port-btn {
    background: #151922; border: 1px solid var(--border-color); color: var(--text-muted);
    padding: 3px 8px; border-radius: 5px; font-size: 0.75em; font-weight: 700; cursor: pointer;
}
.port-btn.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }

.single-led { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.led-light {
    width: 22px; height: 22px; border-radius: 50%;
    background: #252b3b; border: 2px solid #3b455d; transition: all .1s ease;
}
.led-light.active-led-yellow { background: #ffd600; box-shadow: 0 0 16px #ffd600, 0 0 4px #fff; border-color: #fff; }
.led-light.active-led-green { background: #00e676; box-shadow: 0 0 16px #00e676, 0 0 4px #fff; border-color: #fff; }
.led-label { font-size: 0.8em; color: var(--text-muted); }

.led-bar { display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px; text-align: center; }
.led-col { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.led-col .led-light { width: 20px; height: 20px; }
.led-bit-name { font-size: 0.7em; font-family: var(--font-mono); color: var(--text-muted); }

.uart-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.btn-link { background: transparent; border: none; color: var(--accent-blue); cursor: pointer; font-size: 0.78em; }
.uart-console {
    background: #090b0e; border: 1px solid #1a1e28; color: var(--accent);
    padding: 8px; border-radius: 6px; font-family: var(--font-mono);
    font-size: 0.8em; height: 75px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
}

/* ================= ЭКРАН 3: ПРОЦЕССОР ================= */
.cpu-scroll-area {
    flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px;
}
.cpu-subcard { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 10px; }
.flags-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
.flag-cell {
    background: #141822; border: 1px solid var(--border-color); padding: 3px;
    text-align: center; border-radius: 4px; font-family: var(--font-mono);
}
.flag-cell span { display: block; font-size: 0.68em; color: var(--text-muted); }
.flag-cell b { font-size: 0.82em; color: #64748b; }
.flag-cell.flag-on b { color: var(--accent); text-shadow: 0 0 6px var(--accent); }
.flag-cell.flag-on { border-color: var(--accent); }

.pointers-bar {
    display: flex; justify-content: space-between; padding: 6px 10px;
    background: #141822; border-radius: 6px; border: 1px solid var(--border-color);
    font-size: 0.75em; font-family: var(--font-mono);
}
.ptr b { color: #fff; margin-left: 2px; }

.registers-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.reg-cell {
    background: #141822; border: 1px solid var(--border-color); border-radius: 5px;
    padding: 3px 5px; font-family: var(--font-mono); font-size: 0.74em;
}
.reg-cell.changed { background: rgba(255, 179, 0, 0.2); border-color: var(--accent-gold); }
.reg-name { color: var(--text-muted); display: block; font-size: 0.75em; }
.reg-val-hex { color: #fff; font-weight: 700; }
.reg-val-dec { color: var(--text-muted); font-size: 0.8em; margin-left: 2px; }

.mem-dumps-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dump-view {
    background: #090b0e; border: 1px solid var(--border-color); padding: 6px;
    border-radius: 4px; font-family: var(--font-mono); font-size: 0.7em;
    height: 110px; overflow-y: auto; color: #94a3b8; line-height: 1.35;
}

/* ================= МОБИЛЬНАЯ АДАПТАЦИЯ ================= */
@media (max-width: 600px) {
    .toolbar { flex-direction: column; align-items: stretch; gap: 6px; padding: 6px 8px; }
    .toolbar-left, .toolbar-center { justify-content: space-between; }
    .select-wrapper select { max-width: 180px; }
    .nav-screens { width: 100%; justify-content: space-around; }
}

/* =========================================================
   ЯДРО ЭМУЛЯТОРА AVR ATmega328P
   ========================================================= */

const IO = {
    PINB: 0x23,  DDRB: 0x24,  PORTB: 0x25,
    PINC: 0x26,  DDRC: 0x27,  PORTC: 0x28,
    PIND: 0x29,  DDRD: 0x2A,  PORTD: 0x2B,
    SPL:  0x5D,  SPH:  0x5E,  SREG:  0x5F,
    UCSR0A: 0xC0, UCSR0B: 0xC1, UCSR0C: 0xC2,
    UBRR0L: 0xC4, UBRR0H: 0xC5, UDR0:   0xC6
};

const cpu = {
    r: new Uint8Array(32),
    prevR: new Uint8Array(32),
    ram: new Uint8Array(0x0900),
    pc: 0,
    sp: 0x08FF,
    sreg: { C:0, Z:0, N:0, V:0, S:0, H:0, T:0, I:0 },
    cycles: 0,
    running: false,
    timer: null,
    speed: 30,
    program: [],
    labels: {},
    uartLog: "",
    error: null
};

const vButtons = [
    { id: 'K1', port: 'D', pin: 2, pressed: false },
    { id: 'K2', port: 'D', pin: 3, pressed: false },
    { id: 'K3', port: 'B', pin: 0, pressed: false },
    { id: 'K4', port: 'B', pin: 1, pressed: false },
    { id: 'K5', port: 'B', pin: 2, pressed: false },
    { id: 'K6', port: 'B', pin: 3, pressed: false },
    { id: 'K7', port: 'B', pin: 4, pressed: false },
    { id: 'K8', port: 'B', pin: 5, pressed: false }
];

/* ================= 1. ПАРСЕР КОДА С ПРОВЕРКОЙ ОШИБОК ================= */

function parseProgram(text) {
    const lines = text.split('\n');
    cpu.program = [];
    cpu.labels = {};
    cpu.error = null;
    let instIndex = 0;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        const commentIdx = line.indexOf(';');
        if (commentIdx !== -1) line = line.substring(0, commentIdx).trim();
        if (!line) continue;

        if (line.includes(':')) {
            const parts = line.split(':');
            const lbl = parts[0].trim();
            cpu.labels[lbl.toLowerCase()] = instIndex;
            line = parts.slice(1).join(':').trim();
            if (!line) continue;
        }

        if (line.toLowerCase().startsWith('.db')) {
            const strPart = line.substring(3).trim();
            const rawStr = strPart.replace(/['"]/g, '');
            cpu.program.push({ type: 'DATA_DB', str: rawStr, lineNum: i + 1 });
            instIndex++;
            continue;
        }

        if (line.startsWith('.')) continue;

        const tokens = line.split(/\s+/);
        const op = tokens[0].toLowerCase();
        const argsStr = line.substring(tokens[0].length).trim();
        const args = argsStr ? argsStr.split(',').map(a => a.trim()) : [];

        // ВАЖНО: Проверка ограничения команды LDI (только R16..R31)
        if (op === 'ldi' && args.length >= 1) {
            const regNum = parseReg(args[0]);
            if (regNum < 16) {
                cpu.error = `Строка ${i + 1}: LDI работает только с R16..R31 (R${regNum} недопустим)`;
            }
        }

        cpu.program.push({
            op: op,
            args: args,
            lineNum: i + 1,
            raw: line
        });
        instIndex++;
    }
}

function parseVal(arg) {
    if (!arg) return 0;
    arg = arg.trim().toLowerCase();
    if (arg.includes('low(ramend)')) return 0xFF;
    if (arg.includes('high(ramend)')) return 0x08;
    if (arg.includes('1<<txen0')) return 0x08;
    if (arg.includes('1<<ucsz00') || arg.includes('1<<ucsz01')) return 0x06;

    if (arg.startsWith('0x') || arg.startsWith('$')) return parseInt(arg.replace('$', '0x'), 16);
    if (arg.startsWith('0b')) return parseInt(arg.substring(2), 2);
    if (!isNaN(parseInt(arg))) return parseInt(arg, 10);
    return 0;
}

function parseReg(arg) {
    if (!arg) return 0;
    const clean = arg.replace(/[^0-9]/g, '');
    return Math.min(31, Math.max(0, parseInt(clean, 10) || 0));
}

/* ================= 2. ВЫПОЛНЕНИЕ КОМАНД ================= */

function cpuStep() {
    if (cpu.error) {
        alert("Ошибка в коде: " + cpu.error);
        return;
    }

    if (cpu.program.length === 0) {
        parseProgram(document.getElementById('asmCode').value);
    }
    if (cpu.program.length === 0 || cpu.error) {
        updateUI();
        return;
    }

    if (cpu.pc >= cpu.program.length) {
        cpu.running = false;
        updateUI();
        return;
    }

    cpu.prevR.set(cpu.r);
    const inst = cpu.program[cpu.pc];
    const op = inst.op;
    const a = inst.args;
    let nextPC = cpu.pc + 1;

    switch (op) {
        case 'ldi': {
            const rd = parseReg(a[0]);
            const k = parseVal(a[1]) & 0xFF;
            cpu.r[rd] = k;
            break;
        }
        case 'mov': {
            const rd = parseReg(a[0]);
            const rr = parseReg(a[1]);
            cpu.r[rd] = cpu.r[rr];
            break;
        }
        case 'in': {
            const rd = parseReg(a[0]);
            const portName = a[1].toUpperCase();
            let addr = IO[portName] !== undefined ? IO[portName] : parseVal(a[1]);
            cpu.r[rd] = cpu.ram[addr];
            break;
        }
        case 'out': {
            const portName = a[0].toUpperCase();
            const rr = parseReg(a[1]);
            let addr = IO[portName] !== undefined ? IO[portName] : parseVal(a[0]);
            cpu.ram[addr] = cpu.r[rr];

            if (portName === 'UDR0' || addr === IO.UDR0) {
                cpu.uartLog += String.fromCharCode(cpu.r[rr]);
            }
            break;
        }
        case 'add': {
            const rd = parseReg(a[0]);
            const rr = parseReg(a[1]);
            const res = cpu.r[rd] + cpu.r[rr];
            setFlagsAdd(cpu.r[rd], cpu.r[rr], res);
            cpu.r[rd] = res & 0xFF;
            break;
        }
        case 'adc': {
            const rd = parseReg(a[0]);
            const rr = parseReg(a[1]);
            const res = cpu.r[rd] + cpu.r[rr] + cpu.sreg.C;
            setFlagsAdd(cpu.r[rd], cpu.r[rr], res);
            cpu.r[rd] = res & 0xFF;
            break;
        }
        case 'sub':
        case 'subi': {
            const rd = parseReg(a[0]);
            const k = (op === 'sub') ? cpu.r[parseReg(a[1])] : parseVal(a[1]);
            const res = cpu.r[rd] - k;
            setFlagsSub(cpu.r[rd], k, res);
            cpu.r[rd] = res & 0xFF;
            break;
        }
        case 'inc': {
            const rd = parseReg(a[0]);
            const res = (cpu.r[rd] + 1) & 0xFF;
            cpu.sreg.Z = (res === 0) ? 1 : 0;
            cpu.sreg.N = (res & 0x80) ? 1 : 0;
            cpu.r[rd] = res;
            break;
        }
        case 'dec': {
            const rd = parseReg(a[0]);
            const res = (cpu.r[rd] - 1) & 0xFF;
            cpu.sreg.Z = (res === 0) ? 1 : 0;
            cpu.sreg.N = (res & 0x80) ? 1 : 0;
            cpu.r[rd] = res;
            break;
        }
        case 'and':
        case 'andi': {
            const rd = parseReg(a[0]);
            const k = (op === 'and') ? cpu.r[parseReg(a[1])] : parseVal(a[1]);
            cpu.r[rd] &= k;
            setFlagsLogic(cpu.r[rd]);
            break;
        }
        case 'or':
        case 'ori': {
            const rd = parseReg(a[0]);
            const k = (op === 'or') ? cpu.r[parseReg(a[1])] : parseVal(a[1]);
            cpu.r[rd] |= k;
            setFlagsLogic(cpu.r[rd]);
            break;
        }
        case 'eor': {
            const rd = parseReg(a[0]);
            const rr = parseReg(a[1]);
            cpu.r[rd] ^= cpu.r[rr];
            setFlagsLogic(cpu.r[rd]);
            break;
        }
        case 'clr': {
            const rd = parseReg(a[0]);
            cpu.r[rd] = 0;
            setFlagsLogic(0);
            break;
        }
        case 'ser': {
            const rd = parseReg(a[0]);
            cpu.r[rd] = 0xFF;
            break;
        }
        case 'cpi':
        case 'cp': {
            const rd = parseReg(a[0]);
            const k = (op === 'cp') ? cpu.r[parseReg(a[1])] : parseVal(a[1]);
            const res = cpu.r[rd] - k;
            setFlagsSub(cpu.r[rd], k, res);
            break;
        }
        case 'tst': {
            const rd = parseReg(a[0]);
            setFlagsLogic(cpu.r[rd]);
            break;
        }
        case 'swap': {
            const rd = parseReg(a[0]);
            const val = cpu.r[rd];
            cpu.r[rd] = ((val & 0x0F) << 4) | ((val & 0xF0) >> 4);
            break;
        }
        case 'ror': {
            const rd = parseReg(a[0]);
            const oldC = cpu.sreg.C;
            cpu.sreg.C = cpu.r[rd] & 1;
            cpu.r[rd] = (cpu.r[rd] >> 1) | (oldC << 7);
            setFlagsLogic(cpu.r[rd]);
            break;
        }
        case 'sbi': {
            const portName = a[0].toUpperCase();
            const bit = parseVal(a[1]);
            const addr = IO[portName] !== undefined ? IO[portName] : parseVal(a[0]);
            cpu.ram[addr] |= (1 << bit);
            break;
        }
        case 'cbi': {
            const portName = a[0].toUpperCase();
            const bit = parseVal(a[1]);
            const addr = IO[portName] !== undefined ? IO[portName] : parseVal(a[0]);
            cpu.ram[addr] &= ~(1 << bit);
            break;
        }
        case 'bst': {
            const rd = parseReg(a[0]);
            const bit = parseVal(a[1]);
            cpu.sreg.T = (cpu.r[rd] & (1 << bit)) ? 1 : 0;
            break;
        }
        case 'bld': {
            const rd = parseReg(a[0]);
            const bit = parseVal(a[1]);
            if (cpu.sreg.T) cpu.r[rd] |= (1 << bit);
            else cpu.r[rd] &= ~(1 << bit);
            break;
        }
        case 'sec': cpu.sreg.C = 1; break;
        case 'clc': cpu.sreg.C = 0; break;
        case 'sez': cpu.sreg.Z = 1; break;
        case 'clz': cpu.sreg.Z = 0; break;
        case 'sei': cpu.sreg.I = 1; break;
        case 'cli': cpu.sreg.I = 0; break;

        case 'st': {
            let ptrStr = a[0].toLowerCase();
            const rr = parseReg(a[1]);
            let addr = getPointerAddr(ptrStr.replace('+', '').replace('-', ''));
            if (ptrStr.includes('-')) { addr--; setPointerAddr(ptrStr.replace('-', ''), addr); }
            cpu.ram[addr & 0x08FF] = cpu.r[rr];
            if (ptrStr.includes('+')) { setPointerAddr(ptrStr.replace('+', ''), addr + 1); }
            break;
        }
        case 'ld': {
            const rd = parseReg(a[0]);
            let ptrStr = a[1].toLowerCase();
            let addr = getPointerAddr(ptrStr.replace('+', '').replace('-', ''));
            if (ptrStr.includes('-')) { addr--; setPointerAddr(ptrStr.replace('-', ''), addr); }
            cpu.r[rd] = cpu.ram[addr & 0x08FF];
            if (ptrStr.includes('+')) { setPointerAddr(ptrStr.replace('+', ''), addr + 1); }
            break;
        }
        case 'sts': {
            const addr = parseVal(a[0]);
            const rr = parseReg(a[1]);
            cpu.ram[addr & 0x08FF] = cpu.r[rr];
            break;
        }
        case 'lds': {
            const rd = parseReg(a[0]);
            const addr = parseVal(a[1]);
            cpu.r[rd] = cpu.ram[addr & 0x08FF];
            break;
        }
        case 'push': {
            const rr = parseReg(a[0]);
            cpu.ram[cpu.sp] = cpu.r[rr];
            cpu.sp = (cpu.sp - 1) & 0x08FF;
            break;
        }
        case 'pop': {
            const rd = parseReg(a[0]);
            cpu.sp = (cpu.sp + 1) & 0x08FF;
            cpu.r[rd] = cpu.ram[cpu.sp];
            break;
        }
        case 'jmp':
        case 'rjmp': {
            const lbl = a[0].toLowerCase();
            if (cpu.labels[lbl] !== undefined) nextPC = cpu.labels[lbl];
            break;
        }
        case 'breq': {
            if (cpu.sreg.Z === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brne': {
            if (cpu.sreg.Z === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brcs': {
            if (cpu.sreg.C === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brcc': {
            if (cpu.sreg.C === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brts': {
            if (cpu.sreg.T === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brtc': {
            if (cpu.sreg.T === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'call': {
            cpu.ram[cpu.sp] = (nextPC >> 8) & 0xFF;
            cpu.ram[cpu.sp - 1] = nextPC & 0xFF;
            cpu.sp = (cpu.sp - 2) & 0x08FF;
            nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'ret':
        case 'reti': {
            const high = cpu.ram[(cpu.sp + 2) & 0x08FF];
            const low = cpu.ram[(cpu.sp + 1) & 0x08FF];
            cpu.sp = (cpu.sp + 2) & 0x08FF;
            nextPC = (high << 8) | low;
            break;
        }
    }

    cpu.pc = nextPC;
    cpu.cycles++;

    syncHardwareState();
    updateUI();
}

function setFlagsAdd(a, b, res) {
    cpu.sreg.C = (res > 0xFF) ? 1 : 0;
    cpu.sreg.Z = ((res & 0xFF) === 0) ? 1 : 0;
    cpu.sreg.N = (res & 0x80) ? 1 : 0;
    cpu.sreg.V = (!((a ^ b) & 0x80) && ((a ^ res) & 0x80)) ? 1 : 0;
}
function setFlagsSub(a, b, res) {
    cpu.sreg.C = (a < b) ? 1 : 0;
    cpu.sreg.Z = ((res & 0xFF) === 0) ? 1 : 0;
    cpu.sreg.N = (res & 0x80) ? 1 : 0;
    cpu.sreg.V = (((a ^ b) & 0x80) && ((a ^ res) & 0x80)) ? 1 : 0;
}
function setFlagsLogic(val) {
    cpu.sreg.Z = (val === 0) ? 1 : 0;
    cpu.sreg.N = (val & 0x80) ? 1 : 0;
    cpu.sreg.V = 0;
}

function getPointerAddr(name) {
    if (name === 'x') return (cpu.r[27] << 8) | cpu.r[26];
    if (name === 'y') return (cpu.r[29] << 8) | cpu.r[28];
    if (name === 'z') return (cpu.r[31] << 8) | cpu.r[30];
    return 0;
}
function setPointerAddr(name, val) {
    val &= 0xFFFF;
    if (name === 'x') { cpu.r[27] = (val >> 8) & 0xFF; cpu.r[26] = val & 0xFF; }
    if (name === 'y') { cpu.r[29] = (val >> 8) & 0xFF; cpu.r[28] = val & 0xFF; }
    if (name === 'z') { cpu.r[31] = (val >> 8) & 0xFF; cpu.r[30] = val & 0xFF; }
}

/* ================= 3. ЖЕЛЕЗО И ПЛАТА ================= */

function syncHardwareState() {
    let pinb = 0xFF;
    let pind = 0xFF;

    vButtons.forEach(btn => {
        if (btn.pressed) {
            if (btn.port === 'B') pinb &= ~(1 << btn.pin);
            if (btn.port === 'D') pind &= ~(1 << btn.pin);
        }
    });

    cpu.ram[IO.PINB] = pinb;
    cpu.ram[IO.PIND] = pind;
    cpu.ram[IO.SPL] = cpu.sp & 0xFF;
    cpu.ram[IO.SPH] = (cpu.sp >> 8) & 0xFF;
}

function renderHardware() {
    const portB = cpu.ram[IO.PORTB];
    const isPB5On = (portB & (1 << 5)) !== 0;
    const ledPB5 = document.getElementById('ledPB5');
    if (ledPB5) {
        ledPB5.className = 'led-light ' + (isPB5On ? 'active-led-yellow' : '');
    }

    const portD = cpu.ram[IO.PORTD];
    const container = document.getElementById('portDLeds');
    if (container && container.children.length === 8) {
        for (let i = 7; i >= 0; i--) {
            const led = container.children[7 - i].querySelector('.led-light');
            const isOn = (portD & (1 << i)) !== 0;
            led.className = 'led-light ' + (isOn ? 'active-led-green' : '');
        }
    }

    const term = document.getElementById('uartTerminal');
    if (term && term.textContent !== cpu.uartLog) {
        term.textContent = cpu.uartLog || "UART: нет данных...";
        term.scrollTop = term.scrollHeight;
    }
}

function clearUart() {
    cpu.uartLog = "";
    renderHardware();
}

/* ================= 4. ЗАПУСК И СБРОС ================= */

function toggleRun() {
    cpu.running = !cpu.running;
    const btn = document.getElementById('btnRun');
    const icon = document.getElementById('runIcon');
    const txt = document.getElementById('runText');

    if (cpu.running) {
        btn.classList.add('running');
        icon.textContent = '⏸';
        txt.textContent = 'Пауза';
        runLoop();
    } else {
        btn.classList.remove('running');
        icon.textContent = '▶';
        txt.textContent = 'Пуск';
        clearTimeout(cpu.timer);
    }
}

function runLoop() {
    if (!cpu.running) return;

    const batchSize = Math.max(1, Math.floor(cpu.speed / 20));
    for (let i = 0; i < batchSize; i++) {
        cpuStep();
        if (!cpu.running || cpu.error) break;
    }

    const interval = Math.max(10, Math.floor(1000 / cpu.speed));
    cpu.timer = setTimeout(runLoop, interval);
}

function cpuReset() {
    cpu.running = false;
    clearTimeout(cpu.timer);
    document.getElementById('btnRun').classList.remove('running');
    document.getElementById('runIcon').textContent = '▶';
    document.getElementById('runText').textContent = 'Пуск';

    cpu.r.fill(0);
    cpu.prevR.fill(0);
    cpu.ram.fill(0);
    cpu.pc = 0;
    cpu.sp = 0x08FF;
    cpu.cycles = 0;
    cpu.sreg = { C:0, Z:0, N:0, V:0, S:0, H:0, T:0, I:0 };
    cpu.uartLog = "";

    // Полный парсинг текущего текста из редактора
    parseProgram(document.getElementById('asmCode').value);
    syncHardwareState();
    updateUI();
}

function updateSpeed(val) {
    cpu.speed = parseInt(val, 10);
    document.getElementById('speedVal').textContent = cpu.speed + ' оп/сек';
}

/* ================= 5. ИНТЕРФЕЙС ================= */

function updateUI() {
    document.getElementById('cycleCounter').textContent = `Такты: ${cpu.cycles}`;
    
    const statusElem = document.getElementById('compilerStatus');
    if (cpu.error) {
        statusElem.textContent = '❌ ' + cpu.error;
        statusElem.style.color = '#ff3d00';
    } else {
        statusElem.textContent = `Строка: ${cpu.program[cpu.pc]?.lineNum || 'END'}`;
        statusElem.style.color = '#8b9bb4';
    }

    document.getElementById('valPC').textContent = '0x' + cpu.pc.toString(16).padStart(4, '0').toUpperCase();
    document.getElementById('valSP').textContent = '0x' + cpu.sp.toString(16).padStart(4, '0').toUpperCase();
    document.getElementById('valX').textContent = '0x' + getPointerAddr('x').toString(16).padStart(4, '0').toUpperCase();
    document.getElementById('valY').textContent = '0x' + getPointerAddr('y').toString(16).padStart(4, '0').toUpperCase();
    document.getElementById('valZ').textContent = '0x' + getPointerAddr('z').toString(16).padStart(4, '0').toUpperCase();

    renderFlags();
    renderRegisters();
    renderMemoryDumps();
    renderHardware();
}

function renderFlags() {
    const grid = document.getElementById('flagsGrid');
    const order = ['I', 'T', 'H', 'S', 'V', 'N', 'Z', 'C'];
    grid.innerHTML = order.map(f => `
        <div class="flag-cell ${cpu.sreg[f] ? 'flag-on' : ''}">
            <span>${f}</span>
            <b>${cpu.sreg[f]}</b>
        </div>
    `).join('');
}

function renderRegisters() {
    const grid = document.getElementById('registersGrid');
    let html = '';
    for (let i = 0; i < 32; i++) {
        const changed = cpu.r[i] !== cpu.prevR[i];
        const hex = cpu.r[i].toString(16).padStart(2, '0').toUpperCase();
        html += `
            <div class="reg-cell ${changed ? 'changed' : ''}">
                <span class="reg-name">R${i}</span>
                <span class="reg-val-hex">0x${hex}</span>
                <span class="reg-val-dec">(${cpu.r[i]})</span>
            </div>
        `;
    }
    grid.innerHTML = html;
}

function renderMemoryDumps() {
    const ramBox = document.getElementById('ramDump');
    let ramText = '';
    for (let addr = 0x0100; addr <= 0x0120; addr += 8) {
        let bytes = [];
        for (let b = 0; b < 8; b++) {
            bytes.push(cpu.ram[addr + b].toString(16).padStart(2, '0').toUpperCase());
        }
        ramText += `0x${addr.toString(16).toUpperCase()}: ${bytes.join(' ')}\n`;
    }
    ramBox.textContent = ramText;

    const stackBox = document.getElementById('stackDump');
    let stackText = '';
    for (let addr = 0x08F0; addr <= 0x08F8; addr += 8) {
        let bytes = [];
        for (let b = 0; b < 8; b++) {
            const isSP = (addr + b) === cpu.sp;
            const val = cpu.ram[addr + b].toString(16).padStart(2, '0').toUpperCase();
            bytes.push(isSP ? `[${val}]` : val);
        }
        stackText += `0x${addr.toString(16).toUpperCase()}: ${bytes.join(' ')}\n`;
    }
    stackBox.textContent = stackText;
}

function switchTab(tabId) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active-panel'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    document.getElementById(tabId)?.classList.add('active-panel');
    event.target.classList.add('active');
}

/* ================= 6. ПРИМЕРЫ ПРОГРАММ ================= */

const EXAMPLES = {
    led_blink: 
`; Бегущий огонёк (Порт D)
; Последовательный счёт от 0 до 255
.include "m328pdef.inc"

start:
    ldi r16, 0xFF    ; Порт D на вывод
    out DDRD, r16
    ldi r17, 0x00    ; Начальное значение

loop:
    out PORTD, r17   ; Вывод в светодиоды
    inc r17          ; Увеличиваем счётчик
    rjmp loop        ; Повторяем бесконечно`,

    button_led:
`; Кнопка включает светодиод (PULL-UP)
; Нажатие K1 (PD2) зажигает светодиод L (PB5)
.include "m328pdef.inc"

start:
    sbi DDRB, 5      ; PB5 (Светодиод L) на вывод
    cbi DDRD, 2      ; PD2 (Кнопка K1) на ввод
    sbi PORTD, 2     ; Включаем подтяжку PULL-UP

loop:
    in r17, PIND     ; Считываем состояние выводов
    bst r17, 2       ; Проверяем 2-й бит (Кнопка K1)
    brts led_off     ; Если 1 (не нажата) -> выключаем
    sbi PORTB, 5     ; Нажата (0) -> зажигаем светодиод L!
    rjmp loop

led_off:
    cbi PORTB, 5
    rjmp loop`,

    fibonacci:
`; Числа Фибоначчи в памяти (ОЗУ)
; Запись последовательности с адреса 0x0100
.include "m328pdef.inc"

start:
    ldi xh, 0x01     ; Указатель X -> 0x0100
    ldi xl, 0x00
    ldi r16, 1       ; Первые два числа
    ldi r17, 1

loop:
    st x+, r16       ; Запись в ОЗУ с постинкрементом
    add r17, r16
    brcs finish      ; Выход при переполнении байта
    st x+, r17
    add r16, r17
    brcs finish
    rjmp loop

finish:
    nop`,

    uart_tx:
`; Отправка текста в терминал (UART)
; Вывод символов через регистр UDR0
.include "m328pdef.inc"

start:
    ldi r16, 0x48    ; Буква 'H'
    out UDR0, r16
    ldi r16, 0x69    ; Буква 'i'
    out UDR0, r16
    ldi r16, 0x21    ; Знак '!'
    out UDR0, r16

stop:
    rjmp stop`,

    alu_flags:
`; Арифметика и флаги переполнения
; Исследование флагов C (перенос) и Z (нуль)
.include "m328pdef.inc"

start:
    ldi r16, 250
    ldi r17, 10
    add r16, r17     ; 250 + 10 = 260 -> C=1 (перенос!)
    
    ldi r18, 5
    subi r18, 5      ; 5 - 5 = 0 -> Z=1 (нуль!)
    
    sec              ; Принудительно ставим C=1
    clz              ; Сбрасываем Z=0`
};

function loadSelectedExample() {
    const selector = document.getElementById('exampleSelector');
    const key = selector.value;
    if (EXAMPLES[key]) {
        document.getElementById('asmCode').value = EXAMPLES[key];
        updateLineNumbers();
        cpuReset();
    }
}

function updateLineNumbers() {
    const code = document.getElementById('asmCode').value;
    const lines = code.split('\n').length;
    let nums = '';
    for (let i = 1; i <= lines; i++) nums += i + '\n';
    document.getElementById('lineNumbers').textContent = nums;
}

/* ================= 7. ИНИЦИАЛИЗАЦИЯ ================= */

document.addEventListener('DOMContentLoaded', () => {
    const ledBar = document.getElementById('portDLeds');
    for (let i = 7; i >= 0; i--) {
        const col = document.createElement('div');
        col.className = 'led-col';
        col.innerHTML = `
            <div class="led-light" id="ledPD${i}"></div>
            <span class="led-bit-name">D${i}</span>
        `;
        ledBar.appendChild(col);
    }

    const btnBox = document.getElementById('buttonMatrix');
    vButtons.forEach(btn => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'v-btn';
        b.innerHTML = `${btn.id} <span>P${btn.port}${btn.pin}</span>`;
        
        const press = () => { btn.pressed = true; b.classList.add('pressed'); syncHardwareState(); };
        const release = () => { btn.pressed = false; b.classList.remove('pressed'); syncHardwareState(); };

        b.addEventListener('mousedown', press);
        b.addEventListener('mouseup', release);
        b.addEventListener('mouseleave', release);

        b.addEventListener('touchstart', (e) => { e.preventDefault(); press(); });
        b.addEventListener('touchend', (e) => { e.preventDefault(); release(); });

        btnBox.appendChild(b);
    });

    const txtArea = document.getElementById('asmCode');
    
    // ВАЖНО: Автоматическая пересборка и сброс процессора ПРИ ВВОДЕ ТЕКСТА
    txtArea.addEventListener('input', () => {
        updateLineNumbers();
        cpuReset(); // Авто-сброс: новый код сразу готов к шагу!
    });
    
    txtArea.addEventListener('scroll', () => {
        document.getElementById('lineNumbers').scrollTop = txtArea.scrollTop;
    });

    document.getElementById('exampleSelector').value = 'led_blink';
    loadSelectedExample();

    if (window.innerWidth <= 768) {
        document.getElementById('editorTab')?.classList.add('active-panel');
    }
});

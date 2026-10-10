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
    ram: new Uint8Array(0x0900), // 2304 байта (РОН + I/O + ОЗУ 0x0100..0x08FF)
    pc: 0,
    sp: 0x08FF,
    sreg: { C:0, Z:0, N:0, V:0, S:0, H:0, T:0, I:0 },
    cycles: 0,
    running: false,
    timer: null,
    speed: 40,
    program: [],
    labels: {},
    breakpoints: new Set(),      // Хранилище номеров строк с красной точкой 🔴
    uartLog: "",
    error: null,
    selectedPort: 'D'
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

/* ================= 1. ПАРСЕР И РЕГИСТРЫ XL, XH... ================= */

function parseReg(arg) {
    if (!arg) return 0;
    arg = arg.trim().toLowerCase();

    const aliases = {
        'xl': 26, 'xh': 27,
        'yl': 28, 'yh': 29,
        'zl': 30, 'zh': 31
    };
    if (aliases[arg] !== undefined) return aliases[arg];

    const clean = arg.replace(/[^0-9]/g, '');
    return Math.min(31, Math.max(0, parseInt(clean, 10) || 0));
}

// Надёжный парсер 16-ричных (0x100, $100), двоичных (0b10) и 10-тичных чисел
function parseVal(arg) {
    if (!arg) return 0;
    arg = arg.trim().toLowerCase();

    if (arg.includes('low(ramend)')) return 0xFF;
    if (arg.includes('high(ramend)')) return 0x08;
    if (arg.includes('1<<txen0')) return 0x08;
    if (arg.includes('1<<ucsz00') || arg.includes('1<<ucsz01')) return 0x06;

    if (arg.startsWith('$')) return parseInt(arg.substring(1), 16);
    if (arg.startsWith('0x')) return parseInt(arg.substring(2), 16);
    if (arg.startsWith('0b')) return parseInt(arg.substring(2), 2);
    if (!isNaN(parseInt(arg, 10))) return parseInt(arg, 10);
    return 0;
}

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

        // Поиск меток
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

        // Проверка: LDI работает только с R16..R31
        if (op === 'ldi' && args.length >= 1) {
            const regNum = parseReg(args[0]);
            if (regNum < 16) {
                cpu.error = `Строка ${i + 1}: LDI работает только с R16..R31 (R${regNum} недопустим)`;
            }
        }

        cpu.program.push({ op, args, lineNum: i + 1, raw: line });
        instIndex++;
    }
}

/* ================= 2. БЕЗОПАСНАЯ РАБОТА С ПАМЯТЬЮ ОЗУ ================= */

function writeRAM(addr, val) {
    if (addr >= 0 && addr < cpu.ram.length) {
        cpu.ram[addr] = val & 0xFF;
    }
}

function readRAM(addr) {
    if (addr >= 0 && addr < cpu.ram.length) {
        return cpu.ram[addr];
    }
    return 0;
}

/* ================= 3. ВЫПОЛНЕНИЕ КОМАНД ================= */

function cpuStep() {
    if (cpu.error) {
        haltExecution();
        updateUI();
        return;
    }

    if (cpu.program.length === 0) {
        parseProgram(document.getElementById('asmCode').value);
    }
    if (cpu.program.length === 0 || cpu.error) {
        haltExecution();
        updateUI();
        return;
    }

    if (cpu.pc >= cpu.program.length) {
        haltExecution();
        updateUI();
        return;
    }

    cpu.prevR.set(cpu.r);
    const inst = cpu.program[cpu.pc];
    const op = inst.op;
    const a = inst.args;
    let nextPC = cpu.pc + 1;

    // ВНУТРЕННЯЯ ТОЧКА ОСТАНОВА: команда BREAK или метка BP:
    if (op === 'break') {
        haltExecution();
        updateUI();
        return;
    }

    switch (op) {
        /* ПЕРЕСЫЛКА */
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
            cpu.r[rd] = readRAM(addr);
            break;
        }
        case 'out': {
            const portName = a[0].toUpperCase();
            const rr = parseReg(a[1]);
            let addr = IO[portName] !== undefined ? IO[portName] : parseVal(a[0]);
            writeRAM(addr, cpu.r[rr]);

            if (portName === 'UDR0' || addr === IO.UDR0) {
                cpu.uartLog += String.fromCharCode(cpu.r[rr]);
            }
            break;
        }

        /* АРИФМЕТИКА И УМНОЖЕНИЕ */
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
        case 'sbc':
        case 'sbci': {
            const rd = parseReg(a[0]);
            const k = (op === 'sbc') ? cpu.r[parseReg(a[1])] : parseVal(a[1]);
            const res = cpu.r[rd] - k - cpu.sreg.C;
            setFlagsSub(cpu.r[rd], k + cpu.sreg.C, res);
            cpu.r[rd] = res & 0xFF;
            break;
        }
        case 'mul': {
            const rd = parseReg(a[0]);
            const rr = parseReg(a[1]);
            const res = cpu.r[rd] * cpu.r[rr];
            cpu.r[0] = res & 0xFF;
            cpu.r[1] = (res >> 8) & 0xFF;
            cpu.sreg.C = (res & 0x8000) ? 1 : 0;
            cpu.sreg.Z = (res === 0) ? 1 : 0;
            break;
        }
        case 'muls': {
            const rd = parseReg(a[0]);
            const rr = parseReg(a[1]);
            const v1 = (cpu.r[rd] & 0x80) ? cpu.r[rd] - 256 : cpu.r[rd];
            const v2 = (cpu.r[rr] & 0x80) ? cpu.r[rr] - 256 : cpu.r[rr];
            const res = (v1 * v2) & 0xFFFF;
            cpu.r[0] = res & 0xFF;
            cpu.r[1] = (res >> 8) & 0xFF;
            cpu.sreg.C = (res & 0x8000) ? 1 : 0;
            cpu.sreg.Z = (res === 0) ? 1 : 0;
            break;
        }

        /* 16-БИТНЫЕ СЛОЖЕНИЯ / ВЫЧИТАНИЯ (ADIW / SBIW) */
        case 'adiw': {
            const regStr = a[0].toLowerCase();
            const k = parseVal(a[1]);
            let val = getPointerAddr(regStr.replace('l','').replace('h',''));
            val = (val + k) & 0xFFFF;
            setPointerAddr(regStr.replace('l','').replace('h',''), val);
            cpu.sreg.Z = (val === 0) ? 1 : 0;
            cpu.sreg.C = (val > 0xFFFF) ? 1 : 0;
            break;
        }
        case 'sbiw': {
            const regStr = a[0].toLowerCase();
            const k = parseVal(a[1]);
            let val = getPointerAddr(regStr.replace('l','').replace('h',''));
            val = (val - k) & 0xFFFF;
            setPointerAddr(regStr.replace('l','').replace('h',''), val);
            cpu.sreg.Z = (val === 0) ? 1 : 0;
            cpu.sreg.C = (val < 0) ? 1 : 0;
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
        case 'neg': {
            const rd = parseReg(a[0]);
            const res = (0 - cpu.r[rd]) & 0xFF;
            cpu.sreg.C = (res !== 0) ? 1 : 0;
            setFlagsLogic(res);
            cpu.r[rd] = res;
            break;
        }
        case 'com': {
            const rd = parseReg(a[0]);
            cpu.r[rd] = (~cpu.r[rd]) & 0xFF;
            cpu.sreg.C = 1;
            setFlagsLogic(cpu.r[rd]);
            break;
        }

        /* СРАВНЕНИЯ: CP, CPC (С ПАМЯТЬЮ Z) И CPI */
        case 'cp':
        case 'cpi': {
            const rd = parseReg(a[0]);
            const k = (op === 'cp') ? cpu.r[parseReg(a[1])] : parseVal(a[1]);
            const res = cpu.r[rd] - k;
            setFlagsSub(cpu.r[rd], k, res);
            break;
        }
        case 'cpc': {
            const rd = parseReg(a[0]);
            const rr = parseReg(a[1]);
            const res = cpu.r[rd] - cpu.r[rr] - cpu.sreg.C;
            const prevZ = cpu.sreg.Z;
            setFlagsSub(cpu.r[rd], cpu.r[rr] + cpu.sreg.C, res);
            // Аппаратная особенность AVR: Z сохраняется только если предыдущий шаг тоже был Z=1!
            cpu.sreg.Z = (prevZ === 1 && (res & 0xFF) === 0) ? 1 : 0;
            break;
        }
        case 'tst': {
            const rd = parseReg(a[0]);
            setFlagsLogic(cpu.r[rd]);
            break;
        }

        /* ЛОГИКА */
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
        case 'swap': {
            const rd = parseReg(a[0]);
            const val = cpu.r[rd];
            cpu.r[rd] = ((val & 0x0F) << 4) | ((val & 0xF0) >> 4);
            break;
        }

        /* СДВИГИ */
        case 'lsl': {
            const rd = parseReg(a[0]);
            cpu.sreg.C = (cpu.r[rd] & 0x80) ? 1 : 0;
            cpu.r[rd] = (cpu.r[rd] << 1) & 0xFF;
            setFlagsLogic(cpu.r[rd]);
            break;
        }
        case 'lsr': {
            const rd = parseReg(a[0]);
            cpu.sreg.C = cpu.r[rd] & 1;
            cpu.r[rd] = cpu.r[rd] >> 1;
            setFlagsLogic(cpu.r[rd]);
            break;
        }
        case 'asr': {
            const rd = parseReg(a[0]);
            const msb = cpu.r[rd] & 0x80;
            cpu.sreg.C = cpu.r[rd] & 1;
            cpu.r[rd] = (cpu.r[rd] >> 1) | msb;
            setFlagsLogic(cpu.r[rd]);
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
        case 'rol': {
            const rd = parseReg(a[0]);
            const oldC = cpu.sreg.C;
            cpu.sreg.C = (cpu.r[rd] & 0x80) ? 1 : 0;
            cpu.r[rd] = ((cpu.r[rd] << 1) & 0xFF) | oldC;
            setFlagsLogic(cpu.r[rd]);
            break;
        }

        /* БИТОВЫЕ ОПЕРАЦИИ */
        case 'sbi': {
            const portName = a[0].toUpperCase();
            const bit = parseVal(a[1]);
            const addr = IO[portName] !== undefined ? IO[portName] : parseVal(a[0]);
            writeRAM(addr, readRAM(addr) | (1 << bit));
            break;
        }
        case 'cbi': {
            const portName = a[0].toUpperCase();
            const bit = parseVal(a[1]);
            const addr = IO[portName] !== undefined ? IO[portName] : parseVal(a[0]);
            writeRAM(addr, readRAM(addr) & ~(1 << bit));
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
        case 'sbrs': {
            const rd = parseReg(a[0]);
            const bit = parseVal(a[1]);
            if ((cpu.r[rd] & (1 << bit)) !== 0) nextPC++;
            break;
        }
        case 'sbrc': {
            const rd = parseReg(a[0]);
            const bit = parseVal(a[1]);
            if ((cpu.r[rd] & (1 << bit)) === 0) nextPC++;
            break;
        }

        /* ВСЕ ПЕРЕХОДЫ (ЗНАКОВЫЕ И БЕЗЗНАКОВЫЕ) */
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
        case 'brcs':
        case 'brlo': { // BRLO = BRCS (меньше без знака, C=1)
            if (cpu.sreg.C === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brcc':
        case 'brsh': { // BRSH = BRCC (больше/равно без знака, C=0)
            if (cpu.sreg.C === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brlt': { // Меньше со знаком: S = 1 (N ^ V = 1)
            if (cpu.sreg.S === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brge': { // Больше/равно со знаком: S = 0 (N ^ V = 0)
            if (cpu.sreg.S === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brmi': {
            if (cpu.sreg.N === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'brpl': {
            if (cpu.sreg.N === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'call': {
            writeRAM(cpu.sp, (nextPC >> 8) & 0xFF);
            writeRAM(cpu.sp - 1, nextPC & 0xFF);
            cpu.sp = (cpu.sp - 2) & 0x08FF;
            nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC;
            break;
        }
        case 'ret': {
            const high = readRAM(cpu.sp + 2);
            const low = readRAM(cpu.sp + 1);
            cpu.sp = (cpu.sp + 2) & 0x08FF;
            nextPC = (high << 8) | low;
            break;
        }

        /* ПРЯМАЯ И КОСВЕННАЯ ЗАПИСЬ В ОЗУ (ИСПРАВЛЕНА!) */
        case 'sts': {
            const addr = parseVal(a[0]);
            const rr = parseReg(a[1]);
            writeRAM(addr, cpu.r[rr]);
            break;
        }
        case 'lds': {
            const rd = parseReg(a[0]);
            const addr = parseVal(a[1]);
            cpu.r[rd] = readRAM(addr);
            break;
        }
        case 'st': {
            let ptrStr = a[0].toLowerCase();
            const rr = parseReg(a[1]);
            let addr = getPointerAddr(ptrStr.replace('+', '').replace('-', ''));
            if (ptrStr.includes('-')) { addr--; setPointerAddr(ptrStr.replace('-', ''), addr); }
            writeRAM(addr, cpu.r[rr]);
            if (ptrStr.includes('+')) { setPointerAddr(ptrStr.replace('+', ''), addr + 1); }
            break;
        }
        case 'ld': {
            const rd = parseReg(a[0]);
            let ptrStr = a[1].toLowerCase();
            let addr = getPointerAddr(ptrStr.replace('+', '').replace('-', ''));
            if (ptrStr.includes('-')) { addr--; setPointerAddr(ptrStr.replace('-', ''), addr); }
            cpu.r[rd] = readRAM(addr);
            if (ptrStr.includes('+')) { setPointerAddr(ptrStr.replace('+', ''), addr + 1); }
            break;
        }
        // Запись и чтение со смещением STD/LDD (например: std y+2, r20)
        case 'std': {
            const ptrWithOffset = a[0].toLowerCase();
            const rr = parseReg(a[1]);
            const parts = ptrWithOffset.split('+');
            const ptr = parts[0].trim();
            const offset = parseInt(parts[1] || '0', 10);
            const addr = getPointerAddr(ptr) + offset;
            writeRAM(addr, cpu.r[rr]);
            break;
        }
        case 'ldd': {
            const rd = parseReg(a[0]);
            const ptrWithOffset = a[1].toLowerCase();
            const parts = ptrWithOffset.split('+');
            const ptr = parts[0].trim();
            const offset = parseInt(parts[1] || '0', 10);
            const addr = getPointerAddr(ptr) + offset;
            cpu.r[rd] = readRAM(addr);
            break;
        }
        case 'lpm': {
            const rd = (a.length > 0) ? parseReg(a[0]) : 0;
            const zAddr = getPointerAddr('z');
            const dataObj = cpu.program.find(p => p.type === 'DATA_DB');
            if (dataObj && dataObj.str) {
                cpu.r[rd] = dataObj.str.charCodeAt(zAddr % dataObj.str.length) || 0;
            }
            if (a.length > 1 && a[1].includes('+')) setPointerAddr('z', zAddr + 1);
            break;
        }
        case 'push': {
            const rr = parseReg(a[0]);
            writeRAM(cpu.sp, cpu.r[rr]);
            cpu.sp = (cpu.sp - 1) & 0x08FF;
            break;
        }
        case 'pop': {
            const rd = parseReg(a[0]);
            cpu.sp = (cpu.sp + 1) & 0x08FF;
            cpu.r[rd] = readRAM(cpu.sp);
            break;
        }
    }

    cpu.pc = nextPC;
    cpu.cycles++;

    syncHardwareState();
    updateUI();

    // ПРОВЕРКА КРАСНОЙ ТОЧКИ ОСТАНОВА (BREAKPOINT) ПО НОМЕРУ СТРОКИ
    if (cpu.running && cpu.pc < cpu.program.length) {
        const nextLineNum = cpu.program[cpu.pc].lineNum;
        if (cpu.breakpoints.has(nextLineNum)) {
            haltExecution();
            updateUI();
        }
    }
}

function setFlagsAdd(a, b, res) {
    cpu.sreg.C = (res > 0xFF) ? 1 : 0;
    cpu.sreg.Z = ((res & 0xFF) === 0) ? 1 : 0;
    cpu.sreg.N = (res & 0x80) ? 1 : 0;
    cpu.sreg.V = (!((a ^ b) & 0x80) && ((a ^ res) & 0x80)) ? 1 : 0;
    cpu.sreg.S = cpu.sreg.N ^ cpu.sreg.V; // Флаг истинного знака
}
function setFlagsSub(a, b, res) {
    cpu.sreg.C = (a < b) ? 1 : 0;
    cpu.sreg.Z = ((res & 0xFF) === 0) ? 1 : 0;
    cpu.sreg.N = (res & 0x80) ? 1 : 0;
    cpu.sreg.V = (((a ^ b) & 0x80) && ((a ^ res) & 0x80)) ? 1 : 0;
    cpu.sreg.S = cpu.sreg.N ^ cpu.sreg.V; // Флаг знака для BRLT / BRGE!
}
function setFlagsLogic(val) {
    cpu.sreg.Z = (val === 0) ? 1 : 0;
    cpu.sreg.N = (val & 0x80) ? 1 : 0;
    cpu.sreg.V = 0;
    cpu.sreg.S = cpu.sreg.N;
}

function getPointerAddr(name) {
    name = name.toLowerCase();
    if (name === 'x' || name === 'xl' || name === 'xh') return (cpu.r[27] << 8) | cpu.r[26];
    if (name === 'y' || name === 'yl' || name === 'yh') return (cpu.r[29] << 8) | cpu.r[28];
    if (name === 'z' || name === 'zl' || name === 'zh') return (cpu.r[31] << 8) | cpu.r[30];
    return 0;
}
function setPointerAddr(name, val) {
    name = name.toLowerCase();
    val &= 0xFFFF;
    if (name === 'x' || name === 'xl' || name === 'xh') { cpu.r[27] = (val >> 8) & 0xFF; cpu.r[26] = val & 0xFF; }
    if (name === 'y' || name === 'yl' || name === 'yh') { cpu.r[29] = (val >> 8) & 0xFF; cpu.r[28] = val & 0xFF; }
    if (name === 'z' || name === 'zl' || name === 'zh') { cpu.r[31] = (val >> 8) & 0xFF; cpu.r[30] = val & 0xFF; }
}

/* ================= 4. КНОПКИ И ПОРТЫ ================= */

function toggleVButton(id) {
    const btn = vButtons.find(b => b.id === id);
    if (!btn) return;
    btn.pressed = !btn.pressed;
    const elem = document.getElementById('vbtn_' + id);
    if (elem) elem.classList.toggle('latched', btn.pressed);
    syncHardwareState();
    updateUI();
}

function syncHardwareState() {
    let pinb = 0xFF;
    let pind = 0xFF;

    vButtons.forEach(btn => {
        if (btn.pressed) {
            if (btn.port === 'B') pinb &= ~(1 << btn.pin);
            if (btn.port === 'D') pind &= ~(1 << btn.pin);
        }
    });

    writeRAM(IO.PINB, pinb);
    writeRAM(IO.PIND, pind);
    writeRAM(IO.SPL, cpu.sp & 0xFF);
    writeRAM(IO.SPH, (cpu.sp >> 8) & 0xFF);
}

function selectLedPort(portLetter) {
    cpu.selectedPort = portLetter;
    document.querySelectorAll('.port-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('btnPort' + portLetter)?.classList.add('active');
    document.getElementById('ledPortTitle').textContent = `Линейка светодиодов (Порт ${portLetter})`;
    renderHardware();
}

function renderHardware() {
    const portB = readRAM(IO.PORTB);
    const isPB5On = (portB & (1 << 5)) !== 0;
    const ledPB5 = document.getElementById('ledPB5');
    if (ledPB5) {
        ledPB5.className = 'led-light ' + (isPB5On ? 'active-led-yellow' : '');
    }

    let currentVal = 0;
    if (cpu.selectedPort === 'D') currentVal = readRAM(IO.PORTD);
    if (cpu.selectedPort === 'B') currentVal = readRAM(IO.PORTB);
    if (cpu.selectedPort === 'C') currentVal = readRAM(IO.PORTC);

    for (let i = 7; i >= 0; i--) {
        const led = document.getElementById(`ledPin${i}`);
        const bitLbl = document.getElementById(`lblPin${i}`);
        if (led && bitLbl) {
            bitLbl.textContent = `${cpu.selectedPort}${i}`;
            const isOn = (currentVal & (1 << i)) !== 0;
            led.className = 'led-light ' + (isOn ? 'active-led-green' : '');
        }
    }

    const term = document.getElementById('uartTerminal');
    if (term && term.textContent !== cpu.uartLog) {
        term.textContent = cpu.uartLog || "UART готов к приёму данных...";
        term.scrollTop = term.scrollHeight;
    }
}

function clearUart() {
    cpu.uartLog = "";
    renderHardware();
}

/* ================= 5. ЗАПУСК И ТОЧКИ ОСТАНОВА ================= */

function haltExecution() {
    cpu.running = false;
    clearTimeout(cpu.timer);
    const btn = document.getElementById('btnRun');
    if (btn) btn.classList.remove('running');
    document.getElementById('runIcon').textContent = '▶';
    document.getElementById('runText').textContent = 'Пуск';
}

function toggleRun() {
    if (cpu.error) return;
    
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
        haltExecution();
    }
}

function runLoop() {
    if (!cpu.running) return;

    const batchSize = Math.max(1, Math.floor(cpu.speed / 20));
    for (let i = 0; i < batchSize; i++) {
        cpuStep();
        if (!cpu.running || cpu.error) {
            haltExecution();
            break;
        }
    }

    if (cpu.running) {
        const interval = Math.max(10, Math.floor(1000 / cpu.speed));
        cpu.timer = setTimeout(runLoop, interval);
    }
}

function cpuReset() {
    haltExecution();

    cpu.r.fill(0);
    cpu.prevR.fill(0);
    cpu.ram.fill(0);
    cpu.pc = 0;
    cpu.sp = 0x08FF;
    cpu.cycles = 0;
    cpu.sreg = { C:0, Z:0, N:0, V:0, S:0, H:0, T:0, I:0 };
    cpu.uartLog = "";

    parseProgram(document.getElementById('asmCode').value);
    syncHardwareState();
    updateUI();
}

function updateSpeed(val) {
    cpu.speed = parseInt(val, 10);
    document.getElementById('speedVal').textContent = cpu.speed + ' оп/с';
}

function scrollToSlide(index) {
    const viewport = document.getElementById('sliderViewport');
    const panelWidth = viewport.clientWidth;
    viewport.scrollTo({ left: panelWidth * index, behavior: 'smooth' });

    const btns = document.querySelectorAll('.nav-screen-btn');
    btns.forEach((b, i) => b.classList.toggle('active', i === index));
}

// Переключение красной точки останова 🔴
function toggleBreakpoint(lineNum) {
    if (cpu.breakpoints.has(lineNum)) {
        cpu.breakpoints.delete(lineNum);
    } else {
        cpu.breakpoints.add(lineNum);
    }
    renderGutter();
}

/* ================= 6. ПОДСВЕТКА И НОМЕРА СТРОК ================= */

const KNOWN_OPS = new Set([
    'ldi', 'mov', 'add', 'adc', 'sub', 'subi', 'sbc', 'sbci', 'mul', 'muls', 'adiw', 'sbiw',
    'inc', 'dec', 'neg', 'com', 'and', 'andi', 'or', 'ori', 'eor', 'clr', 'ser',
    'cpi', 'cp', 'cpc', 'tst', 'swap', 'ror', 'rol', 'lsl', 'lsr', 'asr',
    'sbi', 'cbi', 'bst', 'bld', 'sbrs', 'sbrc', 'sec', 'clc', 'sez', 'clz',
    'st', 'std', 'ld', 'ldd', 'lpm', 'sts', 'lds', 'push', 'pop',
    'jmp', 'rjmp', 'breq', 'brne', 'brcs', 'brcc', 'brlo', 'brsh', 'brlt', 'brge',
    'brmi', 'brpl', 'call', 'ret', 'in', 'out', 'break', 'nop'
]);

function highlightCode(rawText) {
    const lines = rawText.split('\n');
    return lines.map(line => {
        let comment = '';
        let codePart = line;

        const commentIdx = line.indexOf(';');
        if (commentIdx !== -1) {
            codePart = line.substring(0, commentIdx);
            comment = line.substring(commentIdx);
        }

        let processed = codePart
            .replace(/^(\s*)([a-zA-Z0-9_]+:)/g, '$1<span class="syn-lbl">$2</span>')
            .replace(/(\.[a-zA-Z0-9_]+)/g, '<span class="syn-dir">$1</span>')
            .replace(/\b(\$[0-9a-fA-F]+|0x[0-9a-fA-F]+|0b[01]+|\d+)\b/g, '<span class="syn-num">$1</span>');

        processed = processed.replace(/\b([a-zA-Z]+)\b/g, (match) => {
            if (KNOWN_OPS.has(match.toLowerCase())) {
                return `<span class="syn-op">${match}</span>`;
            }
            return match;
        });

        return processed + (comment ? `<span class="syn-com">${escapeHtml(comment)}</span>` : '');
    }).join('\n');
}

function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function updateSyntax() {
    const code = document.getElementById('asmCode').value;
    document.getElementById('highlightingContent').innerHTML = highlightCode(code) + '\n';
    renderGutter();
}

// Отрисовка левой колонки с номерами строк, 🔴 и ▶
function renderGutter() {
    const code = document.getElementById('asmCode').value;
    const linesCount = code.split('\n').length;
    const gutter = document.getElementById('lineGutter');
    
    // Номер строки, на которой стоит PC
    const currentLineNum = cpu.program[cpu.pc]?.lineNum || -1;

    let html = '';
    for (let i = 1; i <= linesCount; i++) {
        const hasBP = cpu.breakpoints.has(i);
        const isPC = (i === currentLineNum);
        html += `
            <div class="gutter-row ${hasBP ? 'has-bp' : ''} ${isPC ? 'is-pc' : ''}" onclick="toggleBreakpoint(${i})">
                <span class="bp-marker"></span>
                <span class="pc-arrow">▶</span>
                <span class="gutter-num">${i}</span>
            </div>
        `;
    }
    gutter.innerHTML = html;
}

function clearEditor() {
    document.getElementById('asmCode').value = '';
    document.getElementById('exampleSelector').value = 'empty';
    document.getElementById('hintBanner').style.display = 'none';
    cpu.breakpoints.clear();
    updateSyntax();
    cpuReset();
}

/* ================= 7. ИНТЕРФЕЙС И РЕНДЕР ================= */

function updateUI() {
    document.getElementById('cycleCounter').textContent = `Такты: ${cpu.cycles}`;
    
    const statusElem = document.getElementById('compilerStatus');
    if (cpu.error) {
        statusElem.textContent = '❌ ' + cpu.error;
        statusElem.style.color = '#ff3d00';
    } else {
        const curLine = cpu.program[cpu.pc]?.lineNum || 'END';
        statusElem.textContent = `Строка: ${curLine}`;
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
    renderGutter(); // Обновляет жёлтую стрелку ▶ на строке!
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

// Дамп памяти ОЗУ (наглядно показывает ячейки 0x0100+)
function renderMemoryDumps() {
    const ramBox = document.getElementById('ramDump');
    let ramText = 'ОЗУ 0x0100:\n';
    for (let addr = 0x0100; addr <= 0x0120; addr += 8) {
        let bytes = [];
        for (let b = 0; b < 8; b++) {
            bytes.push(readRAM(addr + b).toString(16).padStart(2, '0').toUpperCase());
        }
        ramText += `0x${addr.toString(16).toUpperCase()}: ${bytes.join(' ')}\n`;
    }
    ramBox.textContent = ramText;

    const stackBox = document.getElementById('stackDump');
    let stackText = 'Стек 0x08F0-0x08FF:\n';
    for (let addr = 0x08F0; addr <= 0x08F8; addr += 8) {
        let bytes = [];
        for (let b = 0; b < 8; b++) {
            const isSP = (addr + b) === cpu.sp;
            const val = readRAM(addr + b).toString(16).padStart(2, '0').toUpperCase();
            bytes.push(isSP ? `[${val}]` : val);
        }
        stackText += `0x${addr.toString(16).toUpperCase()}: ${bytes.join(' ')}\n`;
    }
    stackBox.textContent = stackText;
}

/* ================= 8. БИБЛИОТЕКА ПРОГРАММ ================= */

const PROGRAMS = {
    empty: {
        hint: "",
        code: 
`; Новый чистый файл
.include "m328pdef.inc"

start:
    ; Пишите ваши команды здесь
`
    },

    // ТВОЯ ПРОГРАММА СОРТИРОВКИ ИЗ СКРИНШОТА
    sort_ram: {
        hint: "Программа записывает 5 чисел в ОЗУ (0x0100..0x0104) и <b>сортирует их по возрастанию</b>. Нажмите «Пуск» и наблюдайте за дампом ОЗУ!",
        code:
`; Сортировка массива в ОЗУ (0x0100)
.include "m328pdef.inc"

; Запись 5 неотсортированных чисел в ОЗУ:
ldi r16, 0x16
sts 0x0100, r16
ldi r16, 0x03
sts 0x0101, r16
ldi r16, 0x25
sts 0x0102, r16
ldi r16, 0x45
sts 0x0103, r16
ldi r16, 0x01
sts 0x0104, r16

ldi r20, 4          ; Внешний цикл (N-1)
out_1:
    ldi xh, 0x01    ; Указатель X на начало массива
    ldi xl, 0x00
    ldi r21, 4      ; Внутренний цикл

in_1:
    ld r16, x+      ; Читаем элемент A и смещаем адрес
    ld r17, x       ; Читаем элемент B
    cp r16, r17     ; Сравниваем A и B
    brlo no_s       ; Если A < B -> не меняем (BRLO)

    ; Обмен элементов местами:
    st x, r16
    st -x, r17
    adiw xl, 1      ; Возвращаем X на позицию

no_s:
    dec r21
    brne in_1
    dec r20
    brne out_1

finish:
    break           ; Точка останова!
    rjmp finish`
    },

    btn_counter: {
        hint: "Нажмите кнопку <b>K3 (PB0)</b>, чтобы прибавить <b>+1</b> к регистру R0. Нажмите <b>K4 (PB1)</b>, чтобы вычесть <b>-1</b>. Светодиоды Порта D покажут число!",
        code: 
`; Счётчик по кнопкам (K3: +1, K4: -1)
.include "m328pdef.inc"

start:
    ser r16
    out DDRD, r16     ; PD0-PD7 на ВЫВОД (светодиоды)
    cbi DDRB, 0      ; Кнопка K3 (PB0) на ввод
    cbi DDRB, 1      ; Кнопка K4 (PB1) на ввод
    sbi PORTB, 0     ; Подтяжка PULL-UP
    sbi PORTB, 1
    clr r0           ; Обнуляем счётчик R0

loop:
    out PORTD, r0    ; Выводим число R0 в светодиоды Порта D
    in r17, PINB     ; Считываем состояние кнопок
    
    sbrs r17, 0      ; Если кнопка K3 нажата (бит 0 = 0), увеличиваем
    inc r0
    
    sbrs r17, 1      ; Если кнопка K4 нажата (бит 1 = 0), уменьшаем
    dec r0
    
    rjmp loop`
    },

    led_blink: {
        hint: "Нажмите <b>«Пуск»</b>, чтобы запустить автоматический счётчик от 0 до 255. Светодиоды Порта D будут бежать в реальном времени.",
        code:
`; Бегущий огонёк (Порт D)
.include "m328pdef.inc"

start:
    ldi r16, 0xFF    ; Порт D на вывод
    out DDRD, r16
    ldi r17, 0x00    ; Начальное значение счётчика

loop:
    out PORTD, r17   ; Вывод числа в светодиоды
    inc r17          ; Увеличиваем счётчик
    rjmp loop`
    },

    button_led: {
        hint: "Нажмите кнопку <b>K1</b> — светодиод <b>L (PB5)</b> загорится. Нажмите K1 ещё раз — светодиод погаснет.",
        code:
`; Кнопка включает светодиод L
.include "m328pdef.inc"

start:
    sbi DDRB, 5      ; PB5 (Светодиод L) на вывод
    cbi DDRD, 2      ; PD2 (Кнопка K1) на ввод
    sbi PORTD, 2     ; Включаем PULL-UP

loop:
    in r17, PIND     ; Считываем входной порт
    bst r17, 2       ; Запоминаем состояние кнопки K1 в флаг T
    brts led_off     ; Если 1 (отжата) -> выключаем
    sbi PORTB, 5     ; Если 0 (нажата) -> зажигаем светодиод L!
    rjmp loop

led_off:
    cbi PORTB, 5
    rjmp loop`
    },

    fibonacci: {
        hint: "Нажмите <b>«Пуск»</b> или <b>«Шаг»</b>, затем перейдите на экран <b>«⚙️ Процессор»</b>: ячейки памяти с адреса 0x0100 заполнятся числами Фибоначчи!",
        code:
`; Числа Фибоначчи в памяти
.include "m328pdef.inc"

start:
    ldi xh, 0x01     ; Указатель X -> адрес ОЗУ 0x0100
    ldi xl, 0x00
    ldi r16, 1       ; Первые два числа последовательности
    ldi r17, 1

loop:
    st x+, r16       ; Запись числа в память с автоинкрементом X+
    add r17, r16     ; Сложение
    brcs finish      ; Выход из цикла при переполнении байта
    st x+, r17
    add r16, r17
    brcs finish
    rjmp loop

finish:
    break            ; Останов отладчика!
    nop`
    },

    uart_tx: {
        hint: "Запустите программу: на экране <b>«💡 Плата»</b> в окне терминала UART появится передаваемый текст!",
        code:
`; Отправка текста в терминал (UART)
.include "m328pdef.inc"

start:
    ldi r16, 0x48    ; Буква 'H'
    out UDR0, r16
    ldi r16, 0x69    ; Буква 'i'
    out UDR0, r16
    ldi r16, 0x21    ; Знак '!'
    out UDR0, r16

stop:
    rjmp stop`
    },

    alu_flags: {
        hint: "Нажимайте <b>«Шаг»</b> и наблюдайте, как переполнение 250+10=260 зажигает флаг <b>C=1</b>, а вычитание 5-5=0 зажигает флаг нуля <b>Z=1</b>.",
        code:
`; Арифметика и флаги переполнения
.include "m328pdef.inc"

start:
    ldi r16, 250
    ldi r17, 10
    add r16, r17     ; 250 + 10 = 260 -> Флаг C=1 (перенос!)
    
    ldi r18, 5
    subi r18, 5      ; 5 - 5 = 0 -> Флаг Z=1 (нуль!)
    
    sec              ; Принудительно ставим C=1
    clz              ; Сбрасываем Z=0`
    }
};

function loadSelectedExample() {
    const key = document.getElementById('exampleSelector').value;
    const banner = document.getElementById('hintBanner');
    
    if (PROGRAMS[key]) {
        document.getElementById('asmCode').value = PROGRAMS[key].code;
        
        if (key === 'empty' || !PROGRAMS[key].hint) {
            banner.style.display = 'none';
        } else {
            banner.style.display = 'flex';
            document.getElementById('hintText').innerHTML = PROGRAMS[key].hint;
        }

        updateSyntax();
        cpuReset();
    }
}

/* ================= 9. СТАРТ И ОБРАБОТЧИКИ ================= */

document.addEventListener('DOMContentLoaded', () => {
    const txtArea = document.getElementById('asmCode');
    const highlighting = document.getElementById('highlighting');
    const gutter = document.getElementById('lineGutter');

    txtArea.addEventListener('input', () => {
        updateSyntax();
        cpuReset();
    });

    // Синхронизация прокрутки текста и левой колонки номеров
    txtArea.addEventListener('scroll', () => {
        highlighting.scrollTop = txtArea.scrollTop;
        highlighting.scrollLeft = txtArea.scrollLeft;
        gutter.scrollTop = txtArea.scrollTop;
    });

    // Горячие клавиши (F11 - Шаг, F9 - Точка останова)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F11') {
            e.preventDefault();
            cpuStep();
        }
        if (e.key === 'F9') {
            e.preventDefault();
            // Получаем строку курсора
            const text = txtArea.value.substring(0, txtArea.selectionStart);
            const lineNum = text.split('\n').length;
            toggleBreakpoint(lineNum);
        }
    });

    loadSelectedExample();
});

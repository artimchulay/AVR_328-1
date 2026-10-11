/* =========================================================
   ЯДРО ЭМУЛЯТОРА AVR ATmega328P (script.js - Монолит)
   ========================================================= */

/* ================= ГЛАВА 1: ПАМЯТЬ И СОСТОЯНИЕ ================= */

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
    ram: new Uint8Array(0x0900), // ОЗУ: РОН + ПУ + память 0x0100..0x08FF
    pc: 0,
    sp: 0x08FF,
    sreg: { C:0, Z:0, N:0, V:0, S:0, H:0, T:0, I:0 },
    cycles: 0,
    running: false,
    timer: null,
    speed: 40,
    program: [],
    labels: {},
    breakpoints: new Set(),
    uartLog: "",
    error: null,
    selectedPort: 'D',
    memView: 'ram',
    memFormat: 'hex'
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

/* ================= ГЛАВА 2: КОМПИЛЯТОР И ПАРСЕР ================= */

function parseReg(arg) {
    if (!arg) return 0;
    arg = arg.trim().toLowerCase();
    const aliases = { 'xl': 26, 'xh': 27, 'yl': 28, 'yh': 29, 'zl': 30, 'zh': 31 };
    if (aliases[arg] !== undefined) return aliases[arg];
    const clean = arg.replace(/[^0-9]/g, '');
    return Math.min(31, Math.max(0, parseInt(clean, 10) || 0));
}

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

function writeRAM(addr, val) {
    if (addr >= 0 && addr < cpu.ram.length) cpu.ram[addr] = val & 0xFF;
}

function readRAM(addr) {
    if (addr >= 0 && addr < cpu.ram.length) return cpu.ram[addr];
    return 0;
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

/* ================= ГЛАВА 3: АЛУ И ВЫПОЛНЕНИЕ КОМАНД ================= */

function cpuStep() {
    if (cpu.error) { haltExecution(); updateUI(); return; }

    if (cpu.program.length === 0) parseProgram(document.getElementById('asmCode').value);
    if (cpu.program.length === 0 || cpu.error || cpu.pc >= cpu.program.length) {
        haltExecution(); updateUI(); return;
    }

    cpu.prevR.set(cpu.r);
    const inst = cpu.program[cpu.pc];
    const op = inst.op;
    const a = inst.args;
    let nextPC = cpu.pc + 1;

    if (op === 'break') { haltExecution(); updateUI(); return; }

    switch (op) {
        case 'ldi': { cpu.r[parseReg(a[0])] = parseVal(a[1]) & 0xFF; break; }
        case 'mov': { cpu.r[parseReg(a[0])] = cpu.r[parseReg(a[1])]; break; }
        case 'in': {
            let addr = IO[a[1].toUpperCase()] !== undefined ? IO[a[1].toUpperCase()] : parseVal(a[1]);
            cpu.r[parseReg(a[0])] = readRAM(addr); break;
        }
        case 'out': {
            let addr = IO[a[0].toUpperCase()] !== undefined ? IO[a[0].toUpperCase()] : parseVal(a[0]);
            writeRAM(addr, cpu.r[parseReg(a[1])]);
            if (a[0].toUpperCase() === 'SPL' || addr === IO.SPL) cpu.sp = (cpu.sp & 0xFF00) | cpu.r[parseReg(a[1])];
            if (a[0].toUpperCase() === 'SPH' || addr === IO.SPH) cpu.sp = (cpu.sp & 0x00FF) | (cpu.r[parseReg(a[1])] << 8);
            if (a[0].toUpperCase() === 'UDR0' || addr === IO.UDR0) cpu.uartLog += String.fromCharCode(cpu.r[parseReg(a[1])]);
            break;
        }
        case 'add': {
            const res = cpu.r[parseReg(a[0])] + cpu.r[parseReg(a[1])];
            setFlagsAdd(cpu.r[parseReg(a[0])], cpu.r[parseReg(a[1])], res);
            cpu.r[parseReg(a[0])] = res & 0xFF; break;
        }
        case 'adc': {
            const res = cpu.r[parseReg(a[0])] + cpu.r[parseReg(a[1])] + cpu.sreg.C;
            setFlagsAdd(cpu.r[parseReg(a[0])], cpu.r[parseReg(a[1])], res);
            cpu.r[parseReg(a[0])] = res & 0xFF; break;
        }
        case 'sub': {
            const k = cpu.r[parseReg(a[1])];
            const res = cpu.r[parseReg(a[0])] - k;
            setFlagsSub(cpu.r[parseReg(a[0])], k, res);
            cpu.r[parseReg(a[0])] = res & 0xFF; break;
        }
        case 'subi': {
            const k = parseVal(a[1]) & 0xFF; // поддержка отрицательных чисел (-3 -> 253)
            const res = cpu.r[parseReg(a[0])] - k;
            setFlagsSub(cpu.r[parseReg(a[0])], k, res);
            cpu.r[parseReg(a[0])] = res & 0xFF; break;
        }
        case 'sbc': {
            const k = cpu.r[parseReg(a[1])];
            const res = cpu.r[parseReg(a[0])] - k - cpu.sreg.C;
            setFlagsSub(cpu.r[parseReg(a[0])], k + cpu.sreg.C, res);
            cpu.r[parseReg(a[0])] = res & 0xFF; break;
        }
        case 'sbci': {
            const k = parseVal(a[1]) & 0xFF;
            const res = cpu.r[parseReg(a[0])] - k - cpu.sreg.C;
            setFlagsSub(cpu.r[parseReg(a[0])], k + cpu.sreg.C, res);
            cpu.r[parseReg(a[0])] = res & 0xFF; break;
        }
        case 'mul': {
            const res = cpu.r[parseReg(a[0])] * cpu.r[parseReg(a[1])];
            cpu.r[0] = res & 0xFF; cpu.r[1] = (res >> 8) & 0xFF;
            cpu.sreg.C = (res & 0x8000) ? 1 : 0; cpu.sreg.Z = (res === 0) ? 1 : 0; break;
        }
        case 'muls': {
            const v1 = (cpu.r[parseReg(a[0])] & 0x80) ? cpu.r[parseReg(a[0])] - 256 : cpu.r[parseReg(a[0])];
            const v2 = (cpu.r[parseReg(a[1])] & 0x80) ? cpu.r[parseReg(a[1])] - 256 : cpu.r[parseReg(a[1])];
            const res = (v1 * v2) & 0xFFFF;
            cpu.r[0] = res & 0xFF; cpu.r[1] = (res >> 8) & 0xFF;
            cpu.sreg.C = (res & 0x8000) ? 1 : 0; cpu.sreg.Z = (res === 0) ? 1 : 0; break;
        }
        case 'adiw': {
            let ptrName = a[0].replace('l','').replace('h','');
            let cur = getPointerAddr(ptrName);
            let k = parseVal(a[1]);
            let sum = cur + k;
            setPointerAddr(ptrName, sum & 0xFFFF);
            cpu.sreg.C = (sum > 0xFFFF) ? 1 : 0;
            cpu.sreg.Z = ((sum & 0xFFFF) === 0) ? 1 : 0;
            cpu.sreg.N = (sum & 0x8000) ? 1 : 0;
            cpu.sreg.V = (!(cur & 0x8000) && (sum & 0x8000)) ? 1 : 0;
            cpu.sreg.S = cpu.sreg.N ^ cpu.sreg.V;
            break;
        }
        case 'sbiw': {
            let ptrName = a[0].replace('l','').replace('h','');
            let cur = getPointerAddr(ptrName);
            let k = parseVal(a[1]);
            let diff = cur - k;
            setPointerAddr(ptrName, diff & 0xFFFF);
            cpu.sreg.C = (cur < k) ? 1 : 0;
            cpu.sreg.Z = ((diff & 0xFFFF) === 0) ? 1 : 0;
            cpu.sreg.N = (diff & 0x8000) ? 1 : 0;
            cpu.sreg.V = ((cur & 0x8000) && !(diff & 0x8000)) ? 1 : 0;
            cpu.sreg.S = cpu.sreg.N ^ cpu.sreg.V;
            break;
        }
        case 'inc': {
            const rIdx = parseReg(a[0]);
            const prev = cpu.r[rIdx];
            const res = (prev + 1) & 0xFF;
            cpu.r[rIdx] = res;
            cpu.sreg.Z = (res === 0) ? 1 : 0;
            cpu.sreg.N = (res & 0x80) ? 1 : 0;
            cpu.sreg.V = (prev === 0x7F) ? 1 : 0;
            cpu.sreg.S = cpu.sreg.N ^ cpu.sreg.V;
            break;
        }
        case 'dec': {
            const rIdx = parseReg(a[0]);
            const prev = cpu.r[rIdx];
            const res = (prev - 1) & 0xFF;
            cpu.r[rIdx] = res;
            cpu.sreg.Z = (res === 0) ? 1 : 0;
            cpu.sreg.N = (res & 0x80) ? 1 : 0;
            cpu.sreg.V = (prev === 0x80) ? 1 : 0;
            cpu.sreg.S = cpu.sreg.N ^ cpu.sreg.V;
            break;
        }
        case 'neg': {
            const res = (0 - cpu.r[parseReg(a[0])]) & 0xFF;
            cpu.sreg.C = (res !== 0) ? 1 : 0; setFlagsLogic(res); cpu.r[parseReg(a[0])] = res; break;
        }
        case 'com': {
            cpu.r[parseReg(a[0])] = (~cpu.r[parseReg(a[0])]) & 0xFF;
            cpu.sreg.C = 1; setFlagsLogic(cpu.r[parseReg(a[0])]); break;
        }
        case 'cp': {
            const k = cpu.r[parseReg(a[1])];
            setFlagsSub(cpu.r[parseReg(a[0])], k, cpu.r[parseReg(a[0])] - k); break;
        }
        case 'cpi': {
            const k = parseVal(a[1]) & 0xFF;
            setFlagsSub(cpu.r[parseReg(a[0])], k, cpu.r[parseReg(a[0])] - k); break;
        }
        case 'cpc': {
            const k = cpu.r[parseReg(a[1])];
            const res = cpu.r[parseReg(a[0])] - k - cpu.sreg.C;
            const prevZ = cpu.sreg.Z;
            setFlagsSub(cpu.r[parseReg(a[0])], k + cpu.sreg.C, res);
            cpu.sreg.Z = (prevZ === 1 && (res & 0xFF) === 0) ? 1 : 0; break;
        }
        case 'tst': { setFlagsLogic(cpu.r[parseReg(a[0])]); break; }
        case 'and': {
            cpu.r[parseReg(a[0])] &= cpu.r[parseReg(a[1])]; setFlagsLogic(cpu.r[parseReg(a[0])]); break;
        }
        case 'andi': {
            cpu.r[parseReg(a[0])] &= (parseVal(a[1]) & 0xFF); setFlagsLogic(cpu.r[parseReg(a[0])]); break;
        }
        case 'or': {
            cpu.r[parseReg(a[0])] |= cpu.r[parseReg(a[1])]; setFlagsLogic(cpu.r[parseReg(a[0])]); break;
        }
        case 'ori': {
            cpu.r[parseReg(a[0])] |= (parseVal(a[1]) & 0xFF); setFlagsLogic(cpu.r[parseReg(a[0])]); break;
        }
        case 'eor': {
            cpu.r[parseReg(a[0])] ^= cpu.r[parseReg(a[1])]; setFlagsLogic(cpu.r[parseReg(a[0])]); break;
        }
        case 'clr': { cpu.r[parseReg(a[0])] = 0; setFlagsLogic(0); break; }
        case 'ser': { cpu.r[parseReg(a[0])] = 0xFF; break; }
        case 'swap': {
            const v = cpu.r[parseReg(a[0])];
            cpu.r[parseReg(a[0])] = ((v & 0x0F) << 4) | ((v & 0xF0) >> 4); break;
        }

        // --- Сдвиги с корректными флагами V и S ---
        case 'lsl': {
            const reg = parseReg(a[0]);
            cpu.sreg.C = (cpu.r[reg] & 0x80) ? 1 : 0;
            cpu.r[reg] = (cpu.r[reg] << 1) & 0xFF;
            setFlagsShift(cpu.r[reg]); break;
        }
        case 'lsr': {
            const reg = parseReg(a[0]);
            cpu.sreg.C = cpu.r[reg] & 1;
            cpu.r[reg] = cpu.r[reg] >> 1;
            setFlagsShift(cpu.r[reg]); break;
        }
        case 'asr': {
            const reg = parseReg(a[0]);
            const msb = cpu.r[reg] & 0x80;
            cpu.sreg.C = cpu.r[reg] & 1;
            cpu.r[reg] = (cpu.r[reg] >> 1) | msb;
            setFlagsShift(cpu.r[reg]); break;
        }
        case 'ror': {
            const reg = parseReg(a[0]);
            const oldC = cpu.sreg.C;
            cpu.sreg.C = cpu.r[reg] & 1;
            cpu.r[reg] = (cpu.r[reg] >> 1) | (oldC << 7);
            setFlagsShift(cpu.r[reg]); break;
        }
        case 'rol': {
            const reg = parseReg(a[0]);
            const oldC = cpu.sreg.C;
            cpu.sreg.C = (cpu.r[reg] & 0x80) ? 1 : 0;
            cpu.r[reg] = ((cpu.r[reg] << 1) & 0xFF) | oldC;
            setFlagsShift(cpu.r[reg]); break;
        }

        case 'sbi': {
            let addr = IO[a[0].toUpperCase()] !== undefined ? IO[a[0].toUpperCase()] : parseVal(a[0]);
            writeRAM(addr, readRAM(addr) | (1 << parseVal(a[1]))); break;
        }
        case 'cbi': {
            let addr = IO[a[0].toUpperCase()] !== undefined ? IO[a[0].toUpperCase()] : parseVal(a[0]);
            writeRAM(addr, readRAM(addr) & ~(1 << parseVal(a[1]))); break;
        }
        case 'bst': { cpu.sreg.T = (cpu.r[parseReg(a[0])] & (1 << parseVal(a[1]))) ? 1 : 0; break; }
        case 'bld': {
            if (cpu.sreg.T) cpu.r[parseReg(a[0])] |= (1 << parseVal(a[1]));
            else cpu.r[parseReg(a[0])] &= ~(1 << parseVal(a[1])); break;
        }
        case 'sec': { cpu.sreg.C = 1; break; }
        case 'clc': { cpu.sreg.C = 0; break; }
        case 'sez': { cpu.sreg.Z = 1; break; }
        case 'clz': { cpu.sreg.Z = 0; break; }
        case 'sen': { cpu.sreg.N = 1; break; }
        case 'cln': { cpu.sreg.N = 0; break; }
        case 'sev': { cpu.sreg.V = 1; break; }
        case 'clv': { cpu.sreg.V = 0; break; }
        case 'set': { cpu.sreg.T = 1; break; }
        case 'clt': { cpu.sreg.T = 0; break; }
        case 'seh': { cpu.sreg.H = 1; break; }
        case 'clh': { cpu.sreg.H = 0; break; }
        case 'sei': { cpu.sreg.I = 1; break; }
        case 'cli': { cpu.sreg.I = 0; break; }
        case 'nop': { break; }

        case 'sbrs': { if ((cpu.r[parseReg(a[0])] & (1 << parseVal(a[1]))) !== 0) nextPC++; break; }
        case 'sbrc': { if ((cpu.r[parseReg(a[0])] & (1 << parseVal(a[1]))) === 0) nextPC++; break; }
        case 'sbis': {
            let addr = IO[a[0].toUpperCase()] !== undefined ? IO[a[0].toUpperCase()] : parseVal(a[0]);
            if ((readRAM(addr) & (1 << parseVal(a[1]))) !== 0) nextPC++; break;
        }
        case 'sbic': {
            let addr = IO[a[0].toUpperCase()] !== undefined ? IO[a[0].toUpperCase()] : parseVal(a[0]);
            if ((readRAM(addr) & (1 << parseVal(a[1]))) === 0) nextPC++; break;
        }
        case 'jmp':
        case 'rjmp': { if (cpu.labels[a[0].toLowerCase()] !== undefined) nextPC = cpu.labels[a[0].toLowerCase()]; break; }
        case 'breq': { if (cpu.sreg.Z === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'brne': { if (cpu.sreg.Z === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'brcs':
        case 'brlo': { if (cpu.sreg.C === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'brcc':
        case 'brsh': { if (cpu.sreg.C === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'brlt': { if (cpu.sreg.S === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'brge': { if (cpu.sreg.S === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'brmi': { if (cpu.sreg.N === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'brpl': { if (cpu.sreg.N === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'brts': { if (cpu.sreg.T === 1) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'brtc': { if (cpu.sreg.T === 0) nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break; }
        case 'call': {
            writeRAM(cpu.sp, (nextPC >> 8) & 0xFF); writeRAM(cpu.sp - 1, nextPC & 0xFF);
            cpu.sp = (cpu.sp - 2) & 0xFFFF; nextPC = cpu.labels[a[0].toLowerCase()] ?? nextPC; break;
        }
        case 'ret': {
            const high = readRAM(cpu.sp + 2), low = readRAM(cpu.sp + 1);
            cpu.sp = (cpu.sp + 2) & 0xFFFF; nextPC = (high << 8) | low; break;
        }
        case 'sts': { writeRAM(parseVal(a[0]), cpu.r[parseReg(a[1])]); break; }
        case 'lds': { cpu.r[parseReg(a[0])] = readRAM(parseVal(a[1])); break; }
        case 'st': {
            let addr = getPointerAddr(a[0].replace('+', '').replace('-', ''));
            if (a[0].includes('-')) { addr--; setPointerAddr(a[0].replace('-', ''), addr); }
            writeRAM(addr, cpu.r[parseReg(a[1])]);
            if (a[0].includes('+')) setPointerAddr(a[0].replace('+', ''), addr + 1); break;
        }
        case 'ld': {
            let addr = getPointerAddr(a[1].replace('+', '').replace('-', ''));
            if (a[1].includes('-')) { addr--; setPointerAddr(a[1].replace('-', ''), addr); }
            cpu.r[parseReg(a[0])] = readRAM(addr);
            if (a[1].includes('+')) setPointerAddr(a[1].replace('+', ''), addr + 1); break;
        }
        case 'std': {
            const parts = a[0].toLowerCase().split('+');
            writeRAM(getPointerAddr(parts[0].trim()) + parseInt(parts[1] || '0', 10), cpu.r[parseReg(a[1])]); break;
        }
        case 'ldd': {
            const parts = a[1].toLowerCase().split('+');
            cpu.r[parseReg(a[0])] = readRAM(getPointerAddr(parts[0].trim()) + parseInt(parts[1] || '0', 10)); break;
        }
        case 'lpm': {
            const dataObj = cpu.program.find(p => p.type === 'DATA_DB');
            if (dataObj && dataObj.str) cpu.r[parseReg(a[0])] = dataObj.str.charCodeAt(getPointerAddr('z') % dataObj.str.length) || 0;
            if (a.length > 1 && a[1].includes('+')) setPointerAddr('z', getPointerAddr('z') + 1); break;
        }
        case 'push': { writeRAM(cpu.sp, cpu.r[parseReg(a[0])]); cpu.sp = (cpu.sp - 1) & 0xFFFF; break; }
        case 'pop': { cpu.sp = (cpu.sp + 1) & 0xFFFF; cpu.r[parseReg(a[0])] = readRAM(cpu.sp); break; }
    }

    cpu.pc = nextPC;
    cpu.cycles++;

    syncHardwareState();
    updateUI();

    // ОСТАНОВ ПО КРАСНОЙ ТОЧКЕ 🔴
    if (cpu.running && cpu.pc < cpu.program.length) {
        if (cpu.breakpoints.has(cpu.program[cpu.pc].lineNum)) {
            haltExecution();
            updateUI();
        }
    }
}

function setFlagsAdd(a, b, res) {
    cpu.sreg.H = (((a & 0x0F) + (b & 0x0F)) > 0x0F) ? 1 : 0;
    cpu.sreg.C = (res > 0xFF) ? 1 : 0; cpu.sreg.Z = ((res & 0xFF) === 0) ? 1 : 0;
    cpu.sreg.N = (res & 0x80) ? 1 : 0; cpu.sreg.V = (!((a ^ b) & 0x80) && ((a ^ res) & 0x80)) ? 1 : 0;
    cpu.sreg.S = cpu.sreg.N ^ cpu.sreg.V;
}
function setFlagsSub(a, b, res) {
    b &= 0xFF;
    cpu.sreg.H = (((a & 0x0F) - (b & 0x0F)) < 0) ? 1 : 0;
    cpu.sreg.C = (a < b) ? 1 : 0; cpu.sreg.Z = ((res & 0xFF) === 0) ? 1 : 0;
    cpu.sreg.N = (res & 0x80) ? 1 : 0; cpu.sreg.V = (((a ^ b) & 0x80) && ((a ^ res) & 0x80)) ? 1 : 0;
    cpu.sreg.S = cpu.sreg.N ^ cpu.sreg.V;
}
function setFlagsLogic(val) {
    cpu.sreg.Z = ((val & 0xFF) === 0) ? 1 : 0; cpu.sreg.N = (val & 0x80) ? 1 : 0;
    cpu.sreg.V = 0; cpu.sreg.S = cpu.sreg.N;
}
function setFlagsShift(val) {
    cpu.sreg.Z = ((val & 0xFF) === 0) ? 1 : 0;
    cpu.sreg.N = (val & 0x80) ? 1 : 0;
    cpu.sreg.V = cpu.sreg.N ^ cpu.sreg.C;
    cpu.sreg.S = cpu.sreg.N ^ cpu.sreg.V;
}

/* ================= ГЛАВА 4: ЖЕЛЕЗО И ПЛАТА ================= */

function toggleVButton(id) {
    const btn = vButtons.find(b => b.id === id);
    if (!btn) return;
    btn.pressed = !btn.pressed;
    document.getElementById('vbtn_' + id)?.classList.toggle('latched', btn.pressed);
    syncHardwareState();
    updateUI();
}

function syncHardwareState() {
    let pinb = 0xFF; let pind = 0xFF;
    vButtons.forEach(btn => {
        if (btn.pressed) {
            if (btn.port === 'B') pinb &= ~(1 << btn.pin);
            if (btn.port === 'D') pind &= ~(1 << btn.pin);
        }
    });

    // Учет направления выводов (если DDR=1, вывод читает состояние порта)
    const ddrb = readRAM(IO.DDRB); const portb = readRAM(IO.PORTB);
    const ddrd = readRAM(IO.DDRD); const portd = readRAM(IO.PORTD);
    pinb = (pinb & ~ddrb) | (portb & ddrb);
    pind = (pind & ~ddrd) | (portd & ddrd);

    writeRAM(IO.PINB, pinb); writeRAM(IO.PIND, pind);
    writeRAM(IO.SPL, cpu.sp & 0xFF); writeRAM(IO.SPH, (cpu.sp >> 8) & 0xFF);
}

function selectLedPort(portLetter) {
    cpu.selectedPort = portLetter;
    document.querySelectorAll('.port-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('btnPort' + portLetter)?.classList.add('active');
    document.getElementById('ledPortTitle').textContent = `Линейка светодиодов (Порт ${portLetter})`;
    renderHardware();
}

function renderHardware() {
    const isPB5On = (readRAM(IO.PORTB) & (1 << 5)) !== 0;
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
            led.className = 'led-light ' + ((currentVal & (1 << i)) !== 0 ? 'active-led-green' : '');
        }
    }

    const term = document.getElementById('uartTerminal');
    if (term && term.textContent !== cpu.uartLog) {
        term.textContent = cpu.uartLog || "UART готов к приёму данных...";
        term.scrollTop = term.scrollHeight;
    }
}

function clearUart() { cpu.uartLog = ""; renderHardware(); }

/* ================= ГЛАВА 5: ИГРОВОЙ ЦИКЛ (ЗАПУСК / ПАУЗА) ================= */

function haltExecution() {
    cpu.running = false; clearTimeout(cpu.timer);
    document.getElementById('btnRun')?.classList.remove('running');
    document.getElementById('runIcon').textContent = '▶';
    document.getElementById('runText').textContent = 'Пуск';
}

function toggleRun() {
    if (cpu.error) return;
    cpu.running = !cpu.running;
    const btn = document.getElementById('btnRun');
    if (cpu.running) {
        btn.classList.add('running');
        document.getElementById('runIcon').textContent = '⏸';
        document.getElementById('runText').textContent = 'Пауза';
        runLoop();
    } else haltExecution();
}

function runLoop() {
    if (!cpu.running) return;
    const batchSize = Math.max(1, Math.floor(cpu.speed / 20));
    for (let i = 0; i < batchSize; i++) {
        cpuStep();
        if (!cpu.running || cpu.error) { haltExecution(); break; }
    }
    if (cpu.running) cpu.timer = setTimeout(runLoop, Math.max(10, Math.floor(1000 / cpu.speed)));
}

function cpuReset() {
    haltExecution();
    cpu.r.fill(0); cpu.prevR.fill(0); cpu.ram.fill(0);
    cpu.pc = 0; cpu.sp = 0x08FF; cpu.cycles = 0;
    cpu.sreg = { C:0, Z:0, N:0, V:0, S:0, H:0, T:0, I:0 };
    cpu.uartLog = "";

    // Сброс и разжатие кнопок
    vButtons.forEach(btn => {
        btn.pressed = false;
        document.getElementById('vbtn_' + btn.id)?.classList.remove('latched');
    });

    parseProgram(document.getElementById('asmCode').value);
    syncHardwareState(); updateUI();
}

function updateSpeed(val) {
    cpu.speed = parseInt(val, 10);
    document.getElementById('speedVal').textContent = cpu.speed + ' оп/с';
}

/* ================= ГЛАВА 6: ОТРИСОВКА ИНТЕРФЕЙСА И ПАМЯТИ ================= */

function setMemView(view) {
    cpu.memView = view;
    document.getElementById('btnMemRAM')?.classList.toggle('active', view === 'ram');
    document.getElementById('btnMemStack')?.classList.toggle('active', view === 'stack');
    renderMemoryDumps();
}

function setMemFormat(format) {
    cpu.memFormat = format;
    document.getElementById('btnFmtHex')?.classList.toggle('active', format === 'hex');
    document.getElementById('btnFmtDec')?.classList.toggle('active', format === 'dec');
    renderMemoryDumps();
}

function renderMemoryDumps() {
    const memBox = document.getElementById('memDumpView');
    if (!memBox) return; // Защита от вылета

    let output = '';
    if (cpu.memView === 'ram') {
        for (let addr = 0x0100; addr <= 0x0138; addr += 8) {
            let bytes = [];
            for (let b = 0; b < 8; b++) {
                let val = readRAM(addr + b);
                bytes.push(cpu.memFormat === 'dec' ? val.toString(10).padStart(3, '0') : val.toString(16).padStart(2, '0').toUpperCase());
            }
            output += `0x${addr.toString(16).toUpperCase()}:  ${bytes.join('  ')}\n`;
        }
    } else {
        for (let addr = 0x08C0; addr <= 0x08F8; addr += 8) {
            let bytes = [];
            for (let b = 0; b < 8; b++) {
                const isSP = ((addr + b) === cpu.sp);
                let val = readRAM(addr + b);
                let valStr = cpu.memFormat === 'dec' ? val.toString(10).padStart(3, '0') : val.toString(16).padStart(2, '0').toUpperCase();
                bytes.push(isSP ? `[${valStr}]` : ` ${valStr} `);
            }
            output += `0x${addr.toString(16).toUpperCase()}: ${bytes.join(' ')}\n`;
        }
    }
    memBox.textContent = output;
}

function updateUI() {
    document.getElementById('cycleCounter').textContent = `Такты: ${cpu.cycles}`;
    const statusElem = document.getElementById('compilerStatus');
    if (cpu.error) {
        statusElem.textContent = '❌ ' + cpu.error; statusElem.style.color = '#ff3d00';
    } else {
        statusElem.textContent = `Строка: ${cpu.program[cpu.pc]?.lineNum || 'END'}`; statusElem.style.color = '#8b9bb4';
    }

    document.getElementById('valPC').textContent = '0x' + cpu.pc.toString(16).padStart(4, '0').toUpperCase();
    document.getElementById('valSP').textContent = '0x' + cpu.sp.toString(16).padStart(4, '0').toUpperCase();
    document.getElementById('valX').textContent = '0x' + getPointerAddr('x').toString(16).padStart(4, '0').toUpperCase();
    document.getElementById('valY').textContent = '0x' + getPointerAddr('y').toString(16).padStart(4, '0').toUpperCase();
    document.getElementById('valZ').textContent = '0x' + getPointerAddr('z').toString(16).padStart(4, '0').toUpperCase();

    const fGrid = document.getElementById('flagsGrid');
    fGrid.innerHTML = ['I','T','H','S','V','N','Z','C'].map(f => `<div class="flag-cell ${cpu.sreg[f] ? 'flag-on' : ''}"><span>${f}</span><b>${cpu.sreg[f]}</b></div>`).join('');

    const rGrid = document.getElementById('registersGrid');
    let rHtml = '';
    for (let i = 0; i < 32; i++) {
        rHtml += `<div class="reg-cell ${cpu.r[i] !== cpu.prevR[i] ? 'changed' : ''}"><span class="reg-name">R${i}</span><span class="reg-val-hex">0x${cpu.r[i].toString(16).padStart(2, '0').toUpperCase()}</span><span class="reg-val-dec">(${cpu.r[i]})</span></div>`;
    }
    rGrid.innerHTML = rHtml;

    renderMemoryDumps();
    renderHardware();
    renderGutter();
}

/* ================= ГЛАВА 7: РЕДАКТОР И ПОДСВЕТКА СИНТАКСИСА ================= */

const KNOWN_OPS = new Set(['ldi','mov','add','adc','sub','subi','sbc','sbci','mul','muls','adiw','sbiw','inc','dec','neg','com','and','andi','or','ori','eor','clr','ser','cpi','cp','cpc','tst','swap','ror','rol','lsl','lsr','asr','sbi','cbi','bst','bld','sbrs','sbrc','sbis','sbic','sec','clc','sez','clz','sen','cln','sev','clv','set','clt','seh','clh','sei','cli','st','std','ld','ldd','lpm','sts','lds','push','pop','jmp','rjmp','breq','brne','brcs','brcc','brlo','brsh','brlt','brge','brmi','brpl','brts','brtc','call','ret','in','out','break','nop']);

function highlightCode(rawText) {
    return rawText.split('\n').map(line => {
        let comment = '', codePart = line, commentIdx = line.indexOf(';');
        if (commentIdx !== -1) { codePart = line.substring(0, commentIdx); comment = line.substring(commentIdx); }

        let processed = codePart
            .replace(/^(\s*)([a-zA-Z0-9_]+:)/g, '$1<span class="syn-lbl">$2</span>')
            .replace(/(\.[a-zA-Z0-9_]+)/g, '<span class="syn-dir">$1</span>')
            .replace(/\b(\$[0-9a-fA-F]+|0x[0-9a-fA-F]+|0b[01]+|-?\d+)\b/g, '<span class="syn-num">$1</span>');

        processed = processed.replace(/\b([a-zA-Z]+)\b/g, (m) => KNOWN_OPS.has(m.toLowerCase()) ? `<span class="syn-op">${m}</span>` : m);
        return processed + (comment ? `<span class="syn-com">${comment.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>` : '');
    }).join('\n');
}

function updateSyntax() {
    const code = document.getElementById('asmCode').value;
    document.getElementById('highlightingContent').innerHTML = highlightCode(code) + '\n';
    renderGutter();
}

function toggleBreakpoint(lineNum) {
    if (cpu.breakpoints.has(lineNum)) cpu.breakpoints.delete(lineNum);
    else cpu.breakpoints.add(lineNum);
    updateSyntax();
}

function renderGutter() {
    const code = document.getElementById('asmCode').value;
    const curLineNum = cpu.program[cpu.pc]?.lineNum || -1;
    let html = '';
    for (let i = 1; i <= code.split('\n').length; i++) {
        html += `<div class="gutter-row ${cpu.breakpoints.has(i) ? 'has-bp' : ''} ${i === curLineNum ? 'is-pc' : ''}" onclick="toggleBreakpoint(${i})"><span class="bp-marker"></span><span class="pc-arrow">▶</span><span class="gutter-num">${i}</span></div>`;
    }
    document.getElementById('lineGutter').innerHTML = html;
}

function clearEditor() {
    document.getElementById('asmCode').value = '';
    document.getElementById('exampleSelector').value = 'empty';
    document.getElementById('hintBanner').style.display = 'none';
    cpu.breakpoints.clear();
    updateSyntax(); cpuReset();
}

function scrollToSlide(index) {
    const viewport = document.getElementById('sliderViewport');
    viewport.scrollTo({ left: viewport.clientWidth * index, behavior: 'smooth' });
    document.querySelectorAll('.nav-screen-btn').forEach((b, i) => b.classList.toggle('active', i === index));
}

/* ================= ГЛАВА 8: ПРИМЕРЫ ПРОГРАММ И СТАРТ ================= */

const PROGRAMS = {
    empty: { hint: "", code: `; Новый чистый файл\n.include "m328pdef.inc"\n\nstart:\n    \n` },
    sort_ram: { hint: "Программа записывает 5 чисел в ОЗУ (0x0100..0x0104) и <b>сортирует их по возрастанию</b>.", code: `; Сортировка массива в ОЗУ (0x0100)\n.include "m328pdef.inc"\n\nldi r16, 0x16\nsts 0x0100, r16\nldi r16, 0x03\nsts 0x0101, r16\nldi r16, 0x25\nsts 0x0102, r16\nldi r16, 0x45\nsts 0x0103, r16\nldi r16, 0x01\nsts 0x0104, r16\n\nldi r20, 4\nout_1:\n    ldi xh, 0x01\n    ldi xl, 0x00\n    ldi r21, 4\n\nin_1:\n    ld r16, x+\n    ld r17, x\n    cp r16, r17\n    brlo no_s\n\n    st x, r16\n    st -x, r17\n    adiw xl, 1\n\nno_s:\n    dec r21\n    brne in_1\n    dec r20\n    brne out_1\n\nfinish:\n    break\n    rjmp finish` },
    btn_counter: { hint: "Нажмите кнопку <b>K3 (PB0)</b> (+1) или <b>K4 (PB1)</b> (-1). Порт D покажет результат!", code: `; Счётчик по кнопкам\n.include "m328pdef.inc"\nstart:\n    ser r16\n    out DDRD, r16\n    cbi DDRB, 0\n    cbi DDRB, 1\n    sbi PORTB, 0\n    sbi PORTB, 1\n    clr r0\nloop:\n    out PORTD, r0\n    in r17, PINB\n    sbrs r17, 0\n    inc r0\n    sbrs r17, 1\n    dec r0\n    rjmp loop` },
    led_blink: { hint: "Автоматический счётчик от 0 до 255 на Порту D.", code: `; Бегущий огонёк\n.include "m328pdef.inc"\nstart:\n    ldi r16, 0xFF\n    out DDRD, r16\n    ldi r17, 0x00\nloop:\n    out PORTD, r17\n    inc r17\n    rjmp loop` },
    button_led: { hint: "Нажмите кнопку <b>K1</b> — светодиод <b>L (PB5)</b> загорится.", code: `; Кнопка включает светодиод L\n.include "m328pdef.inc"\nstart:\n    in r16, DDRB\n    ori r16, 0x20\n    out DDRB, r16\n    in r16, DDRD\n    andi r16, 0xFB\n    out DDRD, r16\n    in r16, PORTD\n    ori r16, 0x04\n    out PORTD, r16\nloop:\n    in r17, PIND\n    sbrs r17, 2\n    rjmp led_on\n    rjmp led_off\nled_on:\n    in r16, PORTB\n    ori r16, 0x20\n    out PORTB, r16\n    rjmp loop\nled_off:\n    in r16, PORTB\n    andi r16, 0xDF\n    out PORTB, r16\n    rjmp loop` },
    fibonacci: { hint: "Нажмите <b>«Пуск»</b>: ячейки памяти заполнятся числами Фибоначчи!", code: `; Числа Фибоначчи в памяти\n.include "m328pdef.inc"\nstart:\n    ldi xh, 0x01\n    ldi xl, 0x00\n    ldi r16, 1\n    ldi r17, 1\nloop:\n    st x+, r16\n    add r17, r16\n    brcs finish\n    st x+, r17\n    add r16, r17\n    brcs finish\n    rjmp loop\nfinish:\n    break\n    nop` },
    uart_tx: { hint: "Отправка текста в виртуальный монитор UART.", code: `; Отправка текста в терминал (UART)\n.include "m328pdef.inc"\nstart:\n    ldi r16, 0x48\n    out UDR0, r16\n    ldi r16, 0x69\n    out UDR0, r16\n    ldi r16, 0x21\n    out UDR0, r16\nstop:\n    break` },
    alu_flags: { hint: "Арифметика: наблюдайте за флагами SREG при переполнении и нуле.", code: `; Арифметика и флаги переполнения\n.include "m328pdef.inc"\nstart:\n    ldi r16, 250\n    ldi r17, 10\n    add r16, r17\n    ldi r18, 5\n    subi r18, 5\n    sec\n    clz\n    break` }
};

function loadSelectedExample() {
    const key = document.getElementById('exampleSelector').value;
    const banner = document.getElementById('hintBanner');
    if (PROGRAMS[key]) {
        document.getElementById('asmCode').value = PROGRAMS[key].code;
        if (key === 'empty' || !PROGRAMS[key].hint) banner.style.display = 'none';
        else { banner.style.display = 'flex'; document.getElementById('hintText').innerHTML = PROGRAMS[key].hint; }
        updateSyntax(); cpuReset();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const txtArea = document.getElementById('asmCode');
    const highlighting = document.getElementById('highlighting');
    const gutter = document.getElementById('lineGutter');

    txtArea.addEventListener('input', () => { updateSyntax(); cpuReset(); });
    txtArea.addEventListener('scroll', () => {
        highlighting.scrollTop = txtArea.scrollTop;
        highlighting.scrollLeft = txtArea.scrollLeft;
        gutter.scrollTop = txtArea.scrollTop;
    });

    document.getElementById('sliderViewport')?.addEventListener('scroll', (e) => {
        const index = Math.round(e.target.scrollLeft / e.target.clientWidth);
        document.querySelectorAll('.nav-screen-btn').forEach((b, i) => b.classList.toggle('active', i === index));
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'F11') { e.preventDefault(); cpuStep(); }
        if (e.key === 'F9') {
            e.preventDefault();
            toggleBreakpoint(txtArea.value.substring(0, txtArea.selectionStart).split('\n').length);
        }
    });

    loadSelectedExample();
});

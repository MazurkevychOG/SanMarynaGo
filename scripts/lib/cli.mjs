// Мінімальний розбір аргументів: --key value, --flag, повторювані --photo a --photo b
export function parseArgs(argv) {
    const out = { _: [], flags: new Set() }, multi = new Set(['photo', 'add-photo', 'remove-photo']);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const k = a.slice(2), v = argv[i + 1];
            if (v !== undefined && !v.startsWith('--')) {
                i++;
                if (multi.has(k)) (out[k] ||= []).push(v); else out[k] = v;
            } else out.flags.add(k);
        } else out._.push(a);
    }
    return out;
}

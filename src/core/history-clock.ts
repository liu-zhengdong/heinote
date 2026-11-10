let order = 0;
/** One action order shared by text history and structural history. */
export function nextHistoryOrder(): number { order += 1; return order; }

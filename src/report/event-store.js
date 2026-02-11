export function createEventStore() {
  const events = [];
  const eventsByType = new Map();

  function addEvent(type, ts, source, rawLine, avoidNearDuplicateMs = 0) {
    if (!eventsByType.has(type)) eventsByType.set(type, []);
    const list = eventsByType.get(type);
    const ms = ts.getTime();
    if (avoidNearDuplicateMs > 0) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const delta = Math.abs(ms - list[i].getTime());
        if (delta <= avoidNearDuplicateMs) return false;
        if (ms - list[i].getTime() > avoidNearDuplicateMs) break;
      }
    }
    list.push(ts);
    events.push({ type, ts, source, rawLine });
    return true;
  }

  function sortAll() {
    events.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    for (const [type, list] of eventsByType.entries()) {
      list.sort((a, b) => a.getTime() - b.getTime());
      eventsByType.set(type, list);
    }
  }

  return {
    events,
    eventsByType,
    addEvent,
    sortAll
  };
}

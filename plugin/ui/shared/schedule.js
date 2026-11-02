// Five-field cron, evaluated in UTC+8 independently of the host timezone.
export function parseCron(expression) {
  const fields = String(expression || '').trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周')
  const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  return fields.map((field, index) => {
    const [min, max] = limits[index], values = new Set()
    for (const part of field.split(',')) {
      const match = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part)
      if (!match) throw new Error('cron 仅支持数字、*、范围、逗号和步长')
      const step = match[2] ? Number(match[2]) : 1
      const ends = match[1] === '*' ? [min, max] : match[1].split('-').map(Number)
      const start = ends[0], end = ends.length > 1 ? ends[1] : match[2] ? max : start
      if (step < 1 || step > max + 1 || start < min || end > max || start > end) throw new Error('cron 数值或步长超出范围')
      for (let n = start; n <= end; n += step) values.add(index === 4 && n === 7 ? 0 : n)
    }
    return { values, wildcard: field === '*' }
  })
}
export function matchesCron(parsed, timestamp) {
  const date = new Date(timestamp + 8 * 3600000)
  const parts = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()]
  const match = parsed.map((p, i) => p.values.has(parts[i]))
  const day = parsed[2].wildcard || parsed[4].wildcard ? match[2] && match[4] : match[2] || match[4]
  return match[0] && match[1] && day && match[3]
}
export function nextTimes(expression, now = Date.now(), count = 3) {
  const parsed = parseCron(expression), result = []
  let time = Math.floor(now / 60000) * 60000 + 60000
  for (let i = 0; i < 527040 && result.length < count; i++, time += 60000) {
    if (matchesCron(parsed, time)) result.push(time)
  }
  return result
}
export function beijingTime(timestamp) {
  return new Date(timestamp + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
}

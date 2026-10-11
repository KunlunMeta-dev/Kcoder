export function countTextOccurrences(value, search) {
  if (!search) return 0
  let count = 0
  let offset = 0
  while (true) {
    const index = value.indexOf(search, offset)
    if (index === -1) return count
    count += 1
    offset = index + search.length
  }
}

export function distanceFromBottom(metrics) {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop)
}

export function processGroup(snapshot, groupName) {
  return snapshot.processMemory.groups.find(group => group.group === groupName) ?? null
}

export function memorySampleRangeKiB(samples) {
  const footprints = samples.map(sample => sample.physicalFootprintKiB)
  return Math.max(...footprints) - Math.min(...footprints)
}

export function medianMemorySample(samples) {
  if (samples.length === 0) return null
  return [...samples].sort((left, right) => left.physicalFootprintKiB - right.physicalFootprintKiB)[
    Math.floor(samples.length / 2)
  ]
}

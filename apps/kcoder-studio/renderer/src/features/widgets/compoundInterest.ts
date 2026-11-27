export function compoundInterest(principal: number, annualRate: number, years: number) {
  if (![principal, annualRate, years].every(Number.isFinite) || principal < 0 || principal > 1e12 ||
    annualRate < -1 || annualRate > 1 || !Number.isInteger(years) || years < 0 || years > 100) {
    throw new Error('Invalid compound-interest input')
  }
  const series = Array.from({ length: years + 1 }, (_, year) => {
    const total = principal * (1 + annualRate) ** year
    return { year, principal, total, earnings: total - principal }
  })
  const total = series.at(-1)!.total
  return { principal, annualRate, years, total, earnings: total - principal, earningsShare: total === 0 ? 0 : (total - principal) / total, series }
}

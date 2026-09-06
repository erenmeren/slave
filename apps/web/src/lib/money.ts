/** Integer minor units → a currency string. The simulated company's money only; real model
 *  spend is a separate figure with its own null-means-unmeasured rule. */
export function formatMinor(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100)
}

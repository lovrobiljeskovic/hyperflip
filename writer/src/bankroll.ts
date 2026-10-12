/** House capacity is the smaller of what the vault may pull (allowance) and what
 * the wallet actually holds (balance): a max-approve with an empty wallet must
 * not let the exposure book reserve risk the mint tx cannot fund. */
export function bankrollRoom(allowance: bigint, balance: bigint): bigint {
  return allowance < balance ? allowance : balance;
}

/** Edge-triggered low-bankroll alert: fires once when room drops below the
 * threshold and re-arms only after it recovers, so a flat-broke wallet does not
 * page on every quote. */
export function lowBankrollAlerter(threshold: bigint): (room: bigint) => boolean {
  let armed = true;
  return (room) => {
    if (room >= threshold) {
      armed = true;
      return false;
    }
    if (!armed) return false;
    armed = false;
    return true;
  };
}

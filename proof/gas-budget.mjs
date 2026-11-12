// Signer-funding arithmetic for the controlled-v3 deployment proof.
//
// A NEAR transaction's signer must hold at least
//   attached_deposit + gas_limit * gas_price
// at submission time: the runtime reserves the *worst case* gas cost against the
// signer before execution and refuses the transaction otherwise (NotEnoughBalance
// / "does not have enough balance X for operation costing Y"). On testnet the gas
// price is 1e9 yocto/Gas, so a 300 Tgas limit demands a 0.3 NEAR float from every
// signer; the local sandbox validator's gas price is ~0, which is why an
// underfunded identity graph passes there and fails only on real testnet.
//
// Kept pure and dependency-free so a unit test can pin the invariant that the
// testnet funding map must satisfy.

export const YOCTO_PER_NEAR = 10n ** 24n;

export function requiredBalanceYocto({ depositYocto = 0n, gasLimit = 0n, gasPriceYocto = 0n }) {
  return BigInt(depositYocto) + BigInt(gasLimit) * BigInt(gasPriceYocto);
}

/** The worst-case NEAR cost of a single call at the given gas price. */
export function gasFloatNear(gasLimit, gasPriceYocto) {
  return (BigInt(gasLimit) * BigInt(gasPriceYocto)) / YOCTO_PER_NEAR;
}

/** The largest attached deposit any single call by this role must carry. */
export function largestDepositYocto(role, { challengeBondYocto = 0n, premiumYocto = 15n * 10n ** 21n } = {}) {
  switch (role) {
    case "owner": return BigInt(YOCTO_PER_NEAR) / 2n; // pool `deposit` = 0.5 NEAR
    case "buyer": return BigInt(premiumYocto); // buy_cover attaches the premium, NOT the payout
    case "attacker": return BigInt(challengeBondYocto); // challenge bond
    case "proposer": return 10n ** 23n; // propose_product attaches the 0.1 NEAR stake
    default: return 0n; // operators / resolvers only sign
  }
}

/**
 * Every role that must satisfy `balance >= deposit + gas float`. Returns the
 * failing roles with their shortfall, so a preflight can fail closed before the
 * expensive deploy instead of mid-lifecycle.
 */
export function underfundedRoles(funding, { gasLimit, gasPriceYocto, challengeBondYocto }) {
  const float = BigInt(gasLimit) * BigInt(gasPriceYocto);
  const out = [];
  for (const [role, nearAmount] of Object.entries(funding)) {
    if (role === "contract") continue; // the contract account is not a signer here
    const balance = BigInt(Math.round(nearAmount * 1e6)) * (YOCTO_PER_NEAR / 1000000n);
    const required = largestDepositYocto(role, { challengeBondYocto }) + float;
    if (balance < required) out.push({ role, balance: balance.toString(), required: required.toString() });
  }
  return out;
}

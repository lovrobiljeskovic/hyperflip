# Multivariate Correlation Model Mathematics

Updated: 2026-09-01

Status: design artifact. These formulas define the proposed multivariate model and its verification
conditions; they do not claim that the current implementation already satisfies them.

## 1. Notation

Let:

- `i, j` index logical underlyings;
- `m` index a prediction-market leg;
- `k(i)` be the cluster containing underlying `i`;
- `G ~ N(0,1)` be a global independent standard-normal factor;
- `C_k ~ N(0,1)` be an independent standard-normal factor for cluster `k`;
- `U_i ~ N(0,1)` be an independent standard-normal factor for underlying `i`;
- `epsilon_m ~ N(0,1)` be independent leg-specific noise;
- `g_i`, `c_i`, and `u_i` be signed factor loadings; and
- `d_i` be residual idiosyncratic variance.

All global, cluster, underlying, and idiosyncratic factors are mutually independent.

## 2. Latent Gaussian factor model

For a market leg `m` on underlying `i`, define the latent standardized variable:

```text
X_m = g_i * G
      + c_i * C_k(i)
      + u_i * U_i
      + sqrt(d_i) * epsilon_m
```

where:

```text
d_i = 1 - g_i^2 - c_i^2 - u_i^2
```

and the admissibility constraint is:

```text
g_i^2 + c_i^2 + u_i^2 <= v_max < 1
```

The current implementation uses `v_max = 0.99`, leaving at least one percent idiosyncratic variance.

Because all factors are standardized and independent:

```text
Var(X_m)
  = g_i^2 + c_i^2 + u_i^2 + d_i
  = 1
```

Each latent variable therefore remains standard normal.

## 3. Implied correlations

For two legs on distinct underlyings `i != j`:

```text
Corr(X_i, X_j)
  = g_i * g_j
    + indicator(k(i) = k(j)) * c_i * c_j
```

They cannot share an underlying factor because `U_i` and `U_j` are independent.

For two distinct market legs on the same underlying `i`:

```text
Corr(X_i, X_i') = g_i^2 + c_i^2 + u_i^2
```

The loadings are signed. Consequently, the model can represent negative return correlations without
confusing return direction with whether a prediction-market leg is YES or NO.

## 4. Matrix construction and PSD proof

Create a factor-loading matrix `B` with one row per underlying or latent market variable:

- one global-factor column containing `g_i`;
- one column per cluster, containing `c_i` only in the underlying's cluster column;
- one optional column per underlying, containing `u_i` only for that underlying; and
- zeroes in all unrelated factor columns.

Define the diagonal residual matrix:

```text
D[i,i] = 1 - ||B[i,:]||_2^2
D[i,j] = 0, i != j
```

The implied correlation matrix is:

```text
R = B * transpose(B) + D
```

Its diagonal is exactly one:

```text
R[i,i] = ||B[i,:]||_2^2 + D[i,i] = 1
```

For any real vector `x`:

```text
x' * R * x
  = x' * B * transpose(B) * x + x' * D * x
  = ||transpose(B) * x||_2^2 + sum_i(D[i,i] * x_i^2)
  >= 0
```

provided every `D[i,i] >= 0`. Therefore `R` is positive semidefinite by construction.

This proof is independent of the number of underlyings. Ten underlyings require more rows, not a
different correctness argument.

## 5. Direction and marginal preservation

Let a leg have marginal win probability `p_m`, with:

```text
0 < p_m < 1
```

Define its standard-normal threshold:

```text
t_m = Phi^{-1}(1 - p_m)
```

where `Phi` is the standard-normal CDF.

Let `s_m` encode the leg's return direction:

```text
s_m = +1  for an upward-return event
s_m = -1  for a downward-return event
```

The leg wins when:

```text
s_m * X_m > t_m
```

Because `s_m * X_m` is also standard normal:

```text
P(s_m * X_m > t_m)
  = 1 - Phi(t_m)
  = p_m
```

Thus the copula changes only joint dependence; it preserves every input marginal probability.

YES/NO market side and return direction remain separate concepts. For an upward market, YES is an
upward-return event and NO is downward; for a downward market the mapping reverses. A band market is
not representable by a single directional latent and remains separately handled or excluded.

## 6. Conditional joint probability

Let `F` be the vector of all shared factors and let `b_m` be the factor-loading row for leg `m`.
Conditional on `F = f`:

```text
X_m | F=f ~ N(b_m * f, d_m)
```

The conditional win probability is:

```text
q_m(f)
  = 1 - Phi((t_m - b_m*f) / sqrt(d_m)),  if s_m = +1

q_m(f)
  = Phi((-t_m - b_m*f) / sqrt(d_m)),     if s_m = -1
```

Legs are conditionally independent after all shared factors are fixed, so:

```text
P(all legs win | F=f) = product_m q_m(f)
```

The unconditional joint probability is:

```text
P(all legs win)
  = integral(product_m q_m(f) * phi_r(f) df)
```

where `phi_r` is the density of the independent standard-normal factor vector. The sparse hierarchy
allows this integral to be evaluated as nested one-dimensional integrals instead of a dense
ten-dimensional normal CDF.

## 7. Why distinct-underlying tickets remain sparse

With one global factor and one factor for each represented cluster, a ticket with distinct
underlyings has factor depth at most two:

```text
global -> cluster -> legs
```

An underlying factor is shared only when more than one leg uses the same underlying:

```text
global -> cluster -> underlying -> legs
```

Therefore ten distinct underlyings can be cheaper than fewer legs containing repeated underlyings.
The runtime budget should be expressed in quadrature points implied by the tree, not solely in leg
count.

## 8. Weighted correlation estimate

For synchronized return pairs `(a_n, b_n)` observed at time `t_n` and calibrated at `T`, use
half-life `h` days:

```text
w_n = 2^(-((T - t_n) / oneDay) / h)
```

Weighted means are:

```text
mean_a = sum_n(w_n * a_n) / sum_n(w_n)
mean_b = sum_n(w_n * b_n) / sum_n(w_n)
```

Weighted covariance and variances are:

```text
cov_ab = sum_n(w_n * (a_n - mean_a) * (b_n - mean_b))
var_a  = sum_n(w_n * (a_n - mean_a)^2)
var_b  = sum_n(w_n * (b_n - mean_b)^2)
```

The pair estimate is:

```text
r_hat = cov_ab / sqrt(var_a * var_b)
```

and the Kish effective sample size is:

```text
n_eff = (sum_n w_n)^2 / sum_n(w_n^2)
```

## 9. Fisher-z confidence interval

For a finite correlation estimate strictly inside `(-1,1)`, define:

```text
z_hat = atanh(r_hat)
se_z  = 1 / sqrt(n_eff - 3)
```

For a two-sided confidence level with normal critical value `z_alpha`:

```text
z_lower = z_hat - z_alpha * se_z
z_upper = z_hat + z_alpha * se_z
```

Transform back to correlation space:

```text
r_lower = tanh(z_lower)
r_upper = tanh(z_upper)
```

For a nominal 95% interval, `z_alpha` is approximately `1.96`. If simultaneous coverage across many
pairs is required, the critical value or promotion policy must explicitly account for multiplicity;
do not silently describe unadjusted per-pair intervals as a simultaneous matrix confidence region.

## 10. Structured factor-fitting objective

For every admitted direct pair `(i,j)`, let:

- `r_hat_ij` be the estimated correlation;
- `omega_ij > 0` be a declared reliability weight; and
- `rho_ij(B)` be the factor model's implied correlation.

One deterministic weighted least-squares objective is:

```text
L_direct(B)
  = sum_(i,j in direct) omega_ij * (rho_ij(B) - r_hat_ij)^2
```

A natural reliability weight is based on Fisher information:

```text
omega_ij = max(1, n_eff_ij - 3)
```

Static fallback values should enter separately as weaker priors or approved ranges. For point priors:

```text
L_fallback(B)
  = lambda_fallback
    * sum_(i,j in fallback) omega^fallback_ij
      * (rho_ij(B) - r_fallback_ij)^2
```

with a declared `lambda_fallback` smaller than the direct-evidence weight scale. The total objective
may be:

```text
L(B) = L_direct(B) + L_fallback(B)
```

subject to:

```text
g_i^2 + c_i^2 + u_i^2 <= v_max
```

The optimizer's low objective is not itself a promotion proof. Pair-level residual gates below are
still required.

## 11. Pair-level fit gates

For each direct pair:

```text
residual_ij = rho_ij(B) - r_hat_ij
```

At minimum, promotion should require both:

```text
abs(residual_ij) <= maxDirectResidual
```

and:

```text
rho_ij(B) in [r_lower_ij, r_upper_ij]
```

for every admitted direct pair, unless a separately reviewed policy defines a stricter simultaneous
confidence region.

For fallback ranges `[f_lower_ij, f_upper_ij]`, require:

```text
rho_ij(B) in [f_lower_ij, f_upper_ij]
```

or quarantine the pair. Do not store an exact fallback point and later imply a materially different
runtime value without recording that residual and policy decision.

## 12. Projection is diagnostic, not calibration

If `R_target` is a pairwise matrix and `R_projected` is its nearest correlation-matrix projection,
the existing diagnostic is:

```text
maxProjectionError
  = max_(i,j) abs(R_projected[i,j] - R_target[i,j])
```

This detects incompatibility in an assembled target matrix. It does not bound the later factor-fit
error:

```text
maxFitError
  = max_(i,j in admitted)
      abs(R_factor[i,j] - R_target[i,j])
```

Both quantities answer different questions. In the proposed model, `R_factor` is already PSD by
construction, so projection should be used only to diagnose inputs or independently catch an
implementation defect.

## 13. Correlation uncertainty and the endpoint problem

For a bivariate Gaussian event, Plackett's identity gives:

```text
d Phi_2(a,b;rho) / d rho = phi_2(a,b;rho) > 0
```

for the lower-tail bivariate CDF. After applying event-direction signs, the joint probability is
monotone in the direction-adjusted scalar correlation. Therefore a declared bivariate correlation
interval reaches its extrema at an endpoint.

For three or more mixed-direction events, changing one common loading scale changes several signed
pair correlations at once. Some changes increase the joint probability while others decrease it.
There is no general monotonic endpoint guarantee. Consequently:

```text
max(P(scaleLower), P(scaleUpper))
```

is not generally equal to:

```text
max_(scale in [scaleLower, scaleUpper]) P(scale)
```

The recorded BTC-up/ETH-up/NVDA-down counterexample in the implementation handoff demonstrates this
with the checked-in table.

The minimal proposed runtime therefore uses the validated point model. If bootstrap scenarios
`B_1, ..., B_S` are later approved, scenario-robust pricing is explicitly:

```text
P_risk = max_(s=1..S) P(all legs win | B_s)
```

This guarantees conservatism only over the finite declared scenario set.

## 14. Exact streaming exponentially weighted moments

Repeatedly recomputing all weighted prefixes is unnecessary. Suppose observations arrive at times
`t_n`, with half-life `h`. Between consecutive observations define:

```text
decay_n = 2^(-((t_n - t_(n-1)) / oneDay) / h)
```

Maintain:

```text
S0_n = decay_n * S0_(n-1) + 1
S1_n = decay_n * S1_(n-1) + x_n
S2_n = decay_n * S2_(n-1) + x_n^2
```

Then:

```text
mean_n     = S1_n / S0_n
variance_n = max(0, S2_n / S0_n - mean_n^2)
sigma_n    = sqrt(variance_n)
```

For a pair `(x_n,y_n)`, also maintain:

```text
Sxy_n = decay_n * Sxy_(n-1) + x_n * y_n
```

so that:

```text
cov_xy_n = Sxy_n / S0_n - mean_x_n * mean_y_n
corr_xy_n = cov_xy_n / (sigma_x_n * sigma_y_n)
```

These recurrences are algebraically identical to exponentially weighting the complete prefix, subject
only to ordinary floating-point evaluation order. They reduce prefix-statistic work from quadratic to
linear in the number of observations.

## 15. Numerical invariants

Every implementation and replay should assert:

```text
all loadings are finite
all marginal probabilities are in (0,1)
all residual variances are >= 0
R is finite and symmetric
diag(R) = 1 within tolerance
minimumEigenvalue(R) >= -tolerance
all reported joint probabilities are finite and in [0,1]
```

Additional behavioral invariants:

- permuting ticket-leg order does not change joint probability;
- zero shared loadings reproduce the independent product;
- a single leg reproduces its marginal;
- opposite sides of the same exact market have joint probability zero;
- duplicating the same side of the same exact market adds no event;
- increasing a bivariate direction-adjusted correlation changes probability in the proven monotone
  direction; and
- factor-tree integration agrees with a slower independent reference on bounded fixtures.

## 16. Scope boundary

These formulas establish internal mathematical validity for the declared Gaussian factor model. They
do not prove that Gaussian dependence is the true market-generating process, that testnet estimates
transfer to mainnet, or that a fitted model is profitable. Those claims require separate empirical
evidence and remain outside this testnet-only design artifact.

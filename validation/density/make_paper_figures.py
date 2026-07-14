"""Paper figures for Section 3.3 (COMTAILS density comparison).

Produces (into article/Comet_tail_simulation_A_C/images/):
  density_profiles.pdf  - 3 panels: radial falloff (case 1), the same-epoch
                          beta-cutoff control (case 1), and case 3 blind vs matched
  density_mip.pdf       - orbital-plane (m,n) max-intensity projection,
                          COMTAILS vs simulator, case 1
Plus PNG previews in the scratchpad for inspection.
"""
import sys
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(r"c:\Users\USER\Desktop\comet_tail_simulation")
VD = ROOT / "validation" / "density"
IMG = ROOT / "article" / "Comet_tail_simulation_A_C" / "images"
SCRATCH = Path(__file__).parent

sys.path.insert(0, str(VD))
from analyze_density import load_comtails_cube, load_sim_cube, bring_to_grid

# Okabe-Ito, fixed order: reference, sim(blind), sim(controlled)
C_REF = "#0072B2"   # blue
C_SIM = "#D55E00"   # vermillion
C_CTL = "#009E73"   # bluish green

plt.rcParams.update({
    "font.size": 8.5,
    "axes.labelsize": 8.5,
    "axes.titlesize": 9,
    "legend.fontsize": 7.5,
    "xtick.labelsize": 7.5,
    "ytick.labelsize": 7.5,
    "lines.linewidth": 1.4,
    "axes.linewidth": 0.6,
    "figure.dpi": 150,
})


def centers(edges):
    e = np.asarray(edges, dtype=float)
    return 0.5 * (e[:-1] + e[1:])


def load_case(case_dir, jd, sp39=False):
    d = VD / case_dir
    suffix = "_sp39" if sp39 else ""
    sim = load_sim_cube(d / f"gpu_density_cube_{jd}_64{suffix}_meta.json")
    ct = load_comtails_cube(d / "comtails_density_cube.npz")
    ct_grid = bring_to_grid(ct, sim["n_edges_km"], sim["m_edges_km"], sim["l_edges_km"])
    return sim, ct_grid["rho_num"]


def radial_profile(rho, n_edges, m_edges, l_edges, nbins=40):
    n_c, m_c, l_c = centers(n_edges), centers(m_edges), centers(l_edges)
    N, M, L = np.meshgrid(n_c, m_c, l_c, indexing="ij")
    r = np.sqrt(N**2 + M**2 + L**2).ravel()
    w = rho.ravel()
    # only shells fully inside the cube (avoid partial-shell corner artifact)
    rmax = min(abs(n_edges[0]), n_edges[-1], abs(m_edges[0]), m_edges[-1],
               abs(l_edges[0]), l_edges[-1])
    keep = r <= rmax
    r, w = r[keep], w[keep]
    rmin = r[r > 0].min()
    bins = np.logspace(np.log10(rmin), np.log10(rmax), nbins + 1)
    idx = np.digitize(r, bins) - 1
    prof = np.full(nbins, np.nan)
    for i in range(nbins):
        sel = idx == i
        if sel.any():
            prof[i] = w[sel].mean()
    rc = np.sqrt(bins[:-1] * bins[1:])
    good = np.isfinite(prof) & (prof > 0)
    p = prof[good]
    return rc[good], p / p.max()


def alongtail_profile(rho, m_edges):
    # cube axes are (n, m, l); mean over n and l
    prof = rho.mean(axis=(0, 2))
    return centers(m_edges), prof / prof.max()


# ---- load data -------------------------------------------------------------
sim1, ct1 = load_case("results_67P_hemi_peri", "JD2457248.50")
sim1m, _ = load_case("results_67P_hemi_peri", "JD2457248.50", sp39=True)
ct1_beta1_src = load_comtails_cube(
    VD / "results_67P_hemi_peri_beta1" / "comtails_density_cube.npz"
)
ct1_beta1 = bring_to_grid(
    ct1_beta1_src,
    sim1m["n_edges_km"],
    sim1m["m_edges_km"],
    sim1m["l_edges_km"],
)["rho_num"]
sim3b, ct3 = load_case("results_67P_hemi_postperi", "JD2457348.50")
sim3c, _ = load_case("results_67P_hemi_postperi", "JD2457348.50", sp39=True)

# ---- Figure 1: profiles ----------------------------------------------------
fig, axes = plt.subplots(1, 3, figsize=(7.0, 2.4))

# (a) radial falloff, case 1
r_ct, p_ct = radial_profile(ct1, sim1["n_edges_km"], sim1["m_edges_km"], sim1["l_edges_km"])
r_s, p_s = radial_profile(sim1["rho_num"], sim1["n_edges_km"], sim1["m_edges_km"], sim1["l_edges_km"])
ax = axes[0]
ax.loglog(r_ct, p_ct, color=C_REF, marker="o", ms=2.5, markevery=2, label="COMTAILS")
ax.loglog(r_s, p_s, color=C_SIM, marker="s", ms=2.5, markevery=2, ls="--", label="This work")
ax.set_xlabel(r"$|\mathbf{r}|$ from nucleus (km)")
ax.set_ylabel("number density (peak-norm.)")
ax.set_title("(a) Radial falloff, Case 1")
ax.legend(frameon=False)

# (b) same-epoch beta-cutoff control, case 1
m_ct, q_ct = alongtail_profile(ct1, sim1["m_edges_km"])
m_s, q_s = alongtail_profile(sim1m["rho_num"], sim1m["m_edges_km"])
m_ctl, q_ctl = alongtail_profile(ct1_beta1, sim1m["m_edges_km"])
ax = axes[1]
ax.semilogy(m_ct / 1e6, q_ct, color=C_REF, marker="o", ms=2.5, markevery=4,
            label="Full COMTAILS")
ax.semilogy(m_s / 1e6, q_s, color=C_SIM, marker="s", ms=2.5, markevery=4,
            ls="--", label=r"GPU, $\beta\leq1$")
ax.semilogy(m_ctl / 1e6, q_ctl, color=C_CTL, marker="^", ms=2.5, markevery=4,
            ls=":", label=r"COMTAILS, $\beta\leq1$")
ax.set_xlabel(r"$m$, along-tail ($10^6$ km)")
ax.set_title("(b) Cutoff control, Case 1")
ax.legend(frameon=False, loc="lower right", fontsize=7, handlelength=1.8,
          handletextpad=0.4, labelspacing=0.25)

# (c) along-tail, case 3: blind vs controlled
m_ct3, q_ct3 = alongtail_profile(ct3, sim3b["m_edges_km"])
m_b, q_b = alongtail_profile(sim3b["rho_num"], sim3b["m_edges_km"])
m_c, q_c = alongtail_profile(sim3c["rho_num"], sim3c["m_edges_km"])
ax = axes[2]
ax.semilogy(m_ct3 / 1e6, q_ct3, color=C_REF, marker="o", ms=2.5, markevery=4, label="COMTAILS")
ax.semilogy(m_b / 1e6, q_b, color=C_SIM, marker="s", ms=2.5, markevery=4, ls="--", label="GPU, blind")
ax.semilogy(m_c / 1e6, q_c, color=C_CTL, marker="^", ms=2.5, markevery=4, ls=":", label="GPU, matched")
ax.set_xlabel(r"$m$, along-tail ($10^6$ km)")
ax.set_title("(c) Along-tail, Case 3")
ax.set_ylim(top=15)
ax.legend(frameon=False, loc="lower right", fontsize=7, handlelength=1.8,
          handletextpad=0.4, labelspacing=0.25)

fig.tight_layout()
fig.savefig(IMG / "density_profiles.pdf", bbox_inches="tight")
fig.savefig(SCRATCH / "density_profiles_preview.png", bbox_inches="tight", dpi=160)
plt.close(fig)

# ---- Figure 2: orbital-plane MIP, case 1 -----------------------------------
def mip_ml(rho):
    # max over l (axis=2) -> (n, m); transpose so m is vertical? keep (m horizontal)
    img = rho.max(axis=2)          # (n, m)
    img = img / img.max()
    # Empty cells are displayed at the lower color-scale limit rather than
    # masked, avoiding block-shaped interpolation artifacts at the noise floor.
    return np.log10(np.maximum(img, 1e-6))

fig, axes = plt.subplots(2, 1, figsize=(3.5, 6.2), sharex=True)
ext = [sim1["m_edges_km"][0] / 1e6, sim1["m_edges_km"][-1] / 1e6,
       sim1["n_edges_km"][0] / 1e6, sim1["n_edges_km"][-1] / 1e6]
cmap = plt.get_cmap("inferno").copy()
cmap.set_bad(cmap(0.0))
for ax, cube, title in [(axes[0], ct1, "COMTAILS"), (axes[1], sim1["rho_num"], "This work")]:
    im = ax.imshow(mip_ml(cube), origin="lower", extent=ext, aspect="equal",
                   cmap=cmap, vmin=-6, vmax=0, interpolation="bilinear")
    ax.set_ylabel(r"$n$, transverse ($10^6$ km)")
    ax.set_title(title)
axes[1].set_xlabel(r"$m$, along-tail ($10^6$ km)")
cb = fig.colorbar(im, ax=axes, shrink=0.9, pad=0.03)
cb.set_label(r"$\log_{10}$ number density (peak-norm.)")
fig.savefig(IMG / "density_mip.pdf", bbox_inches="tight")
fig.savefig(SCRATCH / "density_mip_preview.png", bbox_inches="tight", dpi=160)
plt.close(fig)

print("done")

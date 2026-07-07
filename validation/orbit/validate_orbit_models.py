
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

from hapsira.core.elements import coe2rv
from hapsira.core.propagation import farnocchia

K_SUN_KM3_S2 = 1.32712440018e11
AU_KM = 149597870.7

CASES = [
    {
        "case": "elliptic_67P",
        "csv": "elliptic_67P.csv",
        "title": "Elliptic orbit: 67P/Churyumov-Gerasimenko",
    },
    {
        "case": "hyperbolic_3I_ATLAS",
        "csv": "hyperbolic_3I_ATLAS.csv",
        "title": "Hyperbolic orbit: 3I/ATLAS",
    },
]


def load_simulation_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"Missing simulation export: {path}")

    df = pd.read_csv(path)

    required = {
        "case", "index", "n_points", "span_days", "dt_days", "jd_tdb",
        "e", "q_AU", "i_deg", "Omega_deg", "omega_deg", "t0_JD",
        "sim_x_AU", "sim_y_AU", "sim_z_AU", "sim_rh_AU",
    }
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"{path.name} is missing columns: {missing}")

    return df


def reference_positions_hapsira(df: pd.DataFrame) -> pd.DataFrame:

    e = float(df["e"].iloc[0])
    q_km = float(df["q_AU"].iloc[0]) * AU_KM
    inc = np.deg2rad(float(df["i_deg"].iloc[0]))
    raan = np.deg2rad(float(df["Omega_deg"].iloc[0]))
    argp = np.deg2rad(float(df["omega_deg"].iloc[0]))
    t0_jd = float(df["t0_JD"].iloc[0])

    p_km = q_km * (1.0 + e)

    r0, v0 = coe2rv(K_SUN_KM3_S2, p_km, e, inc, raan, argp, 0.0)

    xs, ys, zs = [], [], []
    for jd in df["jd_tdb"].to_numpy(dtype=float):
        tof_s = (jd - t0_jd) * 86400.0
        rr, _vv = farnocchia(K_SUN_KM3_S2, r0, v0, tof_s)
        xs.append(rr[0] / AU_KM)
        ys.append(rr[1] / AU_KM)
        zs.append(rr[2] / AU_KM)

    ref = pd.DataFrame({
        "ref_x_AU": xs,
        "ref_y_AU": ys,
        "ref_z_AU": zs,
    })
    ref["ref_rh_AU"] = np.sqrt(
        ref["ref_x_AU"] ** 2 + ref["ref_y_AU"] ** 2 + ref["ref_z_AU"] ** 2
    )
    return ref


def compare_sim_to_reference(sim: pd.DataFrame, ref: pd.DataFrame) -> pd.DataFrame:
    out = sim.reset_index(drop=True).copy()
    ref = ref.reset_index(drop=True)

    for col in ["ref_x_AU", "ref_y_AU", "ref_z_AU", "ref_rh_AU"]:
        out[col] = ref[col]

    out["dx_AU"] = out["sim_x_AU"] - out["ref_x_AU"]
    out["dy_AU"] = out["sim_y_AU"] - out["ref_y_AU"]
    out["dz_AU"] = out["sim_z_AU"] - out["ref_z_AU"]

    out["error_AU"] = np.sqrt(
        out["dx_AU"] ** 2 + out["dy_AU"] ** 2 + out["dz_AU"] ** 2
    )
    out["error_km"] = out["error_AU"] * AU_KM
    out["error_m"] = out["error_km"] * 1000.0
    out["relative_error"] = out["error_AU"] / out["ref_rh_AU"]

    return out


def summarize_case(results: pd.DataFrame, case_title: str) -> dict:
    err_m = results["error_m"].to_numpy()
    rel = results["relative_error"].to_numpy()

    return {
        "case": results["case"].iloc[0],
        "description": case_title,
        "n_points": len(results),
        "span_days": float(results["span_days"].iloc[0]),
        "eccentricity": float(results["e"].iloc[0]),
        "mean_error_m": float(np.mean(err_m)),
        "median_error_m": float(np.median(err_m)),
        "rmse_error_m": float(np.sqrt(np.mean(err_m ** 2))),
        "max_error_m": float(np.max(err_m)),
        "mean_relative_error": float(np.mean(rel)),
        "max_relative_error": float(np.max(rel)),
    }


def make_log_error_plot(all_results: pd.DataFrame, out_stem="model_vs_model_error"):
    plt.rcParams.update({
        "font.size": 9.5, "axes.labelsize": 10.5, "axes.linewidth": 0.8,
        "xtick.direction": "in", "ytick.direction": "in",
        "xtick.top": True, "ytick.right": True,
        "ytick.minor.visible": True,
        "legend.frameon": False,
    })
    fig, ax = plt.subplots(figsize=(3.6, 2.9), constrained_layout=True)
    labels = {
        "elliptic_67P": r"67P (elliptic, $e=0.641$)",
        "hyperbolic_3I_ATLAS": r"3I/ATLAS (hyperbolic, $e=6.14$)",
    }
    colors = {"elliptic_67P": "#0072B2", "hyperbolic_3I_ATLAS": "#D55E00"}
    window = 121
    for case_name, group in all_results.groupby("case"):
        smooth = group["error_m"]
        for _ in range(3):
            smooth = smooth.rolling(window, center=True, min_periods=1).mean()
        ax.plot(group["dt_days"], smooth, lw=1.4,
                color=colors.get(case_name),
                label=labels.get(case_name, case_name))
    ax.set_xlabel("Time from reference epoch [days]")
    ax.set_ylabel("Mean 3D position residual [m]")
    ax.set_ylim(bottom=0)
    ax.legend(loc="center right", fontsize=8.0, handlelength=1.6)
    ax.grid(which="major", axis="y", color="0.9", lw=0.5, zorder=0)
    fig.savefig(f"{out_stem}.pdf")
    fig.savefig(f"{out_stem}.png", dpi=250)
    plt.close(fig)


def main():
    all_results = []
    summaries = []

    for case in CASES:
        print(f"\nProcessing {case['case']}...")
        sim = load_simulation_csv(Path(case["csv"]))
        ref = reference_positions_hapsira(sim)
        results = compare_sim_to_reference(sim, ref)
        summary = summarize_case(results, case["title"])

        results.to_csv(f"{case['case']}_model_validation_results.csv", index=False)
        all_results.append(results)
        summaries.append(summary)
        print(pd.DataFrame([summary]).to_string(index=False))

    all_results_df = pd.concat(all_results, ignore_index=True)
    summary_df = pd.DataFrame(summaries)

    all_results_df.to_csv("model_vs_model_all_results.csv", index=False)
    summary_df.to_csv("model_vs_model_summary.csv", index=False)
    make_log_error_plot(all_results_df)

    print("\nSummary:")
    print(summary_df.to_string(index=False))
    print("\nFiles written:")
    print("  elliptic_67P_model_validation_results.csv")
    print("  hyperbolic_3I_ATLAS_model_validation_results.csv")
    print("  model_vs_model_all_results.csv")
    print("  model_vs_model_summary.csv")
    print("  model_vs_model_error.pdf / .png")


if __name__ == "__main__":
    main()

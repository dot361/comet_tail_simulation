
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

import astropy.units as u
from astroquery.jplhorizons import Horizons


AU_KM = u.au.to(u.km)


CASES = [
    {
        "case": "elliptic_67P",
        "csv": "elliptic_67P.csv",
        "horizons_id": "90000702",
        "id_type": None,
        "title": "Elliptic orbit: 67P/Churyumov-Gerasimenko",
    },
    {
        "case": "hyperbolic_3I_ATLAS",
        "csv": "hyperbolic_3I_ATLAS.csv",
        "horizons_id": "3I",
        "id_type": "smallbody",
        "title": "Hyperbolic orbit: 3I/ATLAS",
    },
]


def load_simulation_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(f"Missing simulation export: {path}")

    df = pd.read_csv(path)

    required = {
        "case",
        "horizons_id",
        "index",
        "n_points",
        "span_days",
        "dt_days",
        "jd_tdb",
        "e",
        "q_AU",
        "i_deg",
        "Omega_deg",
        "omega_deg",
        "t0_JD",
        "sim_x_AU",
        "sim_y_AU",
        "sim_z_AU",
        "sim_rh_AU",
    }

    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"{path.name} is missing columns: {missing}")

    return df


import time
from requests.exceptions import ConnectionError, ReadTimeout

def query_horizons_vectors(horizons_id, id_type, epochs_jd, chunk_size=50, max_retries=5):
    """
    Query geometric heliocentric ecliptic Cartesian coordinates from JPL Horizons.

    The query is split into smaller chunks because sending 1000 epochs in one
    request can cause the remote server to reset the connection.
    """

    all_chunks = []
    epochs_jd = np.asarray(epochs_jd, dtype=float)

    total = len(epochs_jd)

    for start in range(0, total, chunk_size):
        end = min(start + chunk_size, total)
        chunk = epochs_jd[start:end]

        print(f"  Querying Horizons epochs {start + 1}-{end} of {total}...")

        last_error = None

        for attempt in range(1, max_retries + 1):
            try:
                obj = Horizons(
                    id=horizons_id,
                    id_type=id_type,
                    location="@sun",
                    epochs=chunk.tolist(),
                )

                vectors = obj.vectors(
                    refplane="ecliptic",
                    aberrations="geometric",
                )

                ref_chunk = pd.DataFrame({
                    "ref_jd_tdb": np.array(vectors["datetime_jd"], dtype=float),
                    "ref_x_AU": np.array(vectors["x"], dtype=float),
                    "ref_y_AU": np.array(vectors["y"], dtype=float),
                    "ref_z_AU": np.array(vectors["z"], dtype=float),
                })

                ref_chunk["ref_rh_AU"] = np.sqrt(
                    ref_chunk["ref_x_AU"] ** 2 +
                    ref_chunk["ref_y_AU"] ** 2 +
                    ref_chunk["ref_z_AU"] ** 2
                )

                all_chunks.append(ref_chunk)

                # Be polite to the remote service.
                time.sleep(0.5)

                break

            except (ConnectionError, ReadTimeout, TimeoutError) as err:
                last_error = err
                wait_seconds = 2 * attempt

                print(
                    f"    Attempt {attempt}/{max_retries} failed. "
                    f"Waiting {wait_seconds} s and retrying..."
                )

                time.sleep(wait_seconds)

        else:
            raise RuntimeError(
                f"Horizons query failed for rows {start + 1}-{end} "
                f"after {max_retries} attempts."
            ) from last_error

    ref = pd.concat(all_chunks, ignore_index=True)

    if len(ref) != total:
        raise RuntimeError(
            f"Horizons returned {len(ref)} rows, but {total} were expected."
        )

    return ref


def compare_sim_to_reference(sim: pd.DataFrame, ref: pd.DataFrame) -> pd.DataFrame:
    if len(sim) != len(ref):
        raise RuntimeError(
            f"Simulation rows = {len(sim)}, reference rows = {len(ref)}. "
            "The number of Horizons rows does not match."
        )

    out = sim.reset_index(drop=True).copy()
    ref = ref.reset_index(drop=True)

    out["ref_jd_tdb"] = ref["ref_jd_tdb"]
    out["ref_x_AU"] = ref["ref_x_AU"]
    out["ref_y_AU"] = ref["ref_y_AU"]
    out["ref_z_AU"] = ref["ref_z_AU"]
    out["ref_rh_AU"] = ref["ref_rh_AU"]

    out["dx_AU"] = out["sim_x_AU"] - out["ref_x_AU"]
    out["dy_AU"] = out["sim_y_AU"] - out["ref_y_AU"]
    out["dz_AU"] = out["sim_z_AU"] - out["ref_z_AU"]

    out["error_AU"] = np.sqrt(
        out["dx_AU"] ** 2 +
        out["dy_AU"] ** 2 +
        out["dz_AU"] ** 2
    )

    out["error_km"] = out["error_AU"] * AU_KM
    out["relative_error"] = out["error_AU"] / out["ref_rh_AU"]

    return out


def summarize_case(results: pd.DataFrame, case_title: str) -> dict:
    err = results["error_km"].to_numpy()
    rel = results["relative_error"].to_numpy()

    # RMSE of the 3D position residual.
    # Since error_km is already sqrt(dx^2+dy^2+dz^2),
    # this is sqrt(mean(error_km^2)).
    rmse_km = np.sqrt(np.mean(err ** 2))

    return {
        "case": results["case"].iloc[0],
        "description": case_title,
        "n_points": len(results),
        "span_days": float(results["span_days"].iloc[0]),
        "eccentricity": float(results["e"].iloc[0]),
        "q_AU": float(results["q_AU"].iloc[0]),
        "mean_error_km": float(np.mean(err)),
        "median_error_km": float(np.median(err)),
        "rmse_error_km": float(rmse_km),
        "p95_error_km": float(np.percentile(err, 95)),
        "max_error_km": float(np.max(err)),
        "mean_relative_error": float(np.mean(rel)),
        "rmse_relative_error": float(np.sqrt(np.mean(rel ** 2))),
        "max_relative_error": float(np.max(rel)),
    }


def make_error_plot(all_results: pd.DataFrame):
    plt.figure(figsize=(9, 5))

    for case_name, group in all_results.groupby("case"):
        plt.plot(
            group["dt_days"],
            group["error_km"],
            linewidth=1.2,
            label=case_name,
        )

    plt.xlabel("Days from perihelion")
    plt.ylabel("3D position residual, km")
    plt.title("Orbit-position validation against Horizons reference vectors")
    plt.legend()
    plt.tight_layout()
    plt.savefig("orbit_validation_1000_points_error_plot.png", dpi=250)
    plt.close()


def make_log_error_plot(all_results: pd.DataFrame):
    plt.figure(figsize=(9, 5))

    for case_name, group in all_results.groupby("case"):
        plt.semilogy(
            group["dt_days"],
            group["error_km"],
            linewidth=1.2,
            label=case_name,
        )

    plt.xlabel("Days from perihelion")
    plt.ylabel("3D position residual, km, logarithmic scale")
    plt.title("Orbit-position validation against Horizons reference vectors")
    plt.legend()
    plt.tight_layout()
    plt.savefig("orbit_validation_1000_points_error_plot_log.png", dpi=250)
    plt.close()


def main():
    all_results = []
    summaries = []

    for case in CASES:
        print(f"\nProcessing {case['case']}...")

        sim = load_simulation_csv(Path(case["csv"]))

        ref = query_horizons_vectors(
            horizons_id=case["horizons_id"],
            id_type=case["id_type"],
            epochs_jd=sim["jd_tdb"].to_numpy(dtype=float),
        )

        results = compare_sim_to_reference(sim, ref)
        summary = summarize_case(results, case["title"])

        results.to_csv(f"{case['case']}_validation_results.csv", index=False)

        all_results.append(results)
        summaries.append(summary)

        print(pd.DataFrame([summary]).to_string(index=False))

    all_results_df = pd.concat(all_results, ignore_index=True)
    summary_df = pd.DataFrame(summaries)

    all_results_df.to_csv("orbit_validation_1000_points_all_results.csv", index=False)
    summary_df.to_csv("orbit_validation_1000_points_summary.csv", index=False)

    make_error_plot(all_results_df)
    make_log_error_plot(all_results_df)

    print("\nSummary:")
    print(summary_df.to_string(index=False))

    print("\nFiles written:")
    print("  elliptic_67P_validation_results.csv")
    print("  hyperbolic_3I_ATLAS_validation_results.csv")
    print("  orbit_validation_1000_points_all_results.csv")
    print("  orbit_validation_1000_points_summary.csv")
    print("  orbit_validation_1000_points_error_plot.png")
    print("  orbit_validation_1000_points_error_plot_log.png")


if __name__ == "__main__":
    main()

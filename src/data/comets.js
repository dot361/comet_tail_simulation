const COMETS = {
  "67P": {
    displayName: "67P/Churyumov–Gerasimenko",
    horizonsId: "90000702",
    horizonsIdType: null,
    validation: {
      caseName: "elliptic_67P",
      spanDays: 180,
      nPoints: 1000
    },
    solutions: [
      {
        e: 0.64090813,
        q: 1.24326564,
        i: 7.04029491,
        omega: 50.135573804414,
        w: 12.798249734157,
        T: 2457247.5887
      }
    ]
  },


  "C2024E1": {
    displayName: "C/2024 E1",
    horizonsId: "C/2024 E1",
    horizonsIdType: "smallbody",
    validation: {
      caseName: "near_parabolic_C2024E1",
      spanDays: 240,
      nPoints: 1000
    },
    solutions: [
      {
        e: 1.00048372,
        q: 0.56171583,
        i: 75.21807230,
        omega: 108.38859762573,
        w: 243.65164937935,
        T: 2461060.9651
      }
    ]
  },

  "133P": {
    displayName: "133P/Elst–Pizarro",
    horizonsId: "133P",
    horizonsIdType: "smallbody",
    validation: {
      caseName: "elliptic_133P",
      spanDays: 180,
      nPoints: 1000
    },
    solutions: [
      {
        e: 0.15637284,
        q: 2.67049635,
        i: 1.38981783,
        omega: 160.09954075742,
        w: 131.90192411846,
        T: 2460440.7000
      }
    ]
  },

  "3I": {
    displayName: "3I/ATLAS",
    horizonsId: "3I",
    horizonsIdType: "smallbody",
    validation: {
      caseName: "hyperbolic_3I_ATLAS",
      spanDays: 600,
      nPoints: 1000
    },
    solutions: [
      {
        e: 6.141351449317625,
        q: 1.356481057231181,
        i: 175.116457085044100,
        omega: 322.169608929077800,
        w: 128.022869718519400,
        T: 2460977.995262847700000
      }
    ]
  }
};

function pickSolutionForJD(solutions, jd) {
  if (!Array.isArray(solutions) || solutions.length === 0) return null;

  let best = solutions[0];
  let bestAbs = Math.abs((solutions[0].T ?? 0) - jd);

  for (let k = 1; k < solutions.length; k++) {
    const d = Math.abs((solutions[k].T ?? 0) - jd);

    if (d < bestAbs) {
      best = solutions[k];
      bestAbs = d;
    }
  }

  return best;
}


window.COMETS = COMETS;
window.pickSolutionForJD = pickSolutionForJD;

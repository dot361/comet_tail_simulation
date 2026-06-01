const fitsObservation = {
  name: "MOST_01.fits — C/2022 E3 (ZTF)",
  object: "C/2022 E3 (ZTF)",
  comet: {
    e: 1.000301905819192,
    qAU: 1.11224437022534,
    iDeg: 109.169480756749,
    OmegaDeg: 302.5550197168474,
    omegaDeg: 145.8149287873,
    perihelionJD: 2459957.2851988296
  },
  dateObs: "2022-10-10T03:14:43.055Z",
  jd: 2459862.6352083,
  mjd: 59862.1352083,
  filter: "ZTF_r",
  exptimeS: 30,
  observer: {
    type: "ground",
    label: "Palomar Observatory",
    lonDeg: -116.8598,
    latDeg: 33.3573,
    altM: 1668
  },
  target: { mode: "radec", raDeg: 238.2889974273, decDeg: 26.66259925336 },
  image: {
    width: 3072,
    height: 3080,
    pixelScaleArcsec: 1.012,
    fovXDeg: 0.8635733333333333,
    fovYDeg: 0.8658222222222223,
    rollDeg: 1.176,
    wcs: {
      radesys: "ICRS", equinox: 2000.0,
      ctype1: "RA---TAN", ctype2: "DEC--TAN", cunit1: "deg", cunit2: "deg",
      crpix1: 1536.5, crpix2: 1540.5,
      crval1: 238.2889974273, crval2: 26.66259925336,
      cd11: -2.812933678669e-4, cd12: 5.759663019966e-6,
      cd21: -5.791634557597e-6, cd22: -2.812725542512e-4
    }
  },
  tail: {
    particleCountPerDay: 1500,
    lifetimeDays: 55,
    activityExponent: 2.0,
    activityScale: 1.0,
    activityHalfLifeEDays: 1200,
    ejectionSpeedMps: 145,
    ejectionBetaExponent: 0.5,
    ejectionDistanceExponent: -0.5,
    sunwardConeSharpness: 2.1,
    betaCurve: {
      enabled: true,
      points: [
        { x: 0.002, y: 1.00 },
        { x: 0.010, y: 0.90 },
        { x: 0.030, y: 0.35 },
        { x: 0.060, y: 0.02 }
      ]
    }
  },
  render: {
    densityKgM3: 1000,
    qpr: 1,
    fitsParticleWeight: 1.0,
    fitsSizeWeightExponent: 0,
    fitsSeeingFwhmPx: 1.8
  }
};
await applyFitsObservationPreset(fitsObservation, { prefill: true, dtDays: 1.0, activateTelescope: true });

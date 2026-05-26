// ─── Planet setup ─────────────────────────────────────────────────────────────

let PLANET_ELTS, planetColors, planets, earthEl, earthMesh, earthLabel;
let planetOrbitMeshes = [];
let planetOrbitsVisible = true;
let planetsVisible = true;

function initPlanets() {
  PLANET_ELTS = PLANET_ELTS_DEG.map(([name, a, e, iDeg, OmegaDeg, varpiDeg, LDeg]) => {
    const omegaDeg = wrapDeg(varpiDeg - OmegaDeg);
    const M0Deg    = wrapDeg(LDeg - varpiDeg);
    return {
      name,
      a, e,
      i:     deg2rad(iDeg),
      Omega: deg2rad(wrapDeg(OmegaDeg)),
      omega: deg2rad(omegaDeg),
      M0:    deg2rad(M0Deg),
      _OmegaDeg: OmegaDeg, _varpiDeg: varpiDeg, _LDeg: LDeg,
      _omegaDeg: omegaDeg, _M0Deg: M0Deg
    };
  });

  planetColors = {
    Mercury: new BABYLON.Color3(0.65, 0.66, 0.68),
    Venus:   new BABYLON.Color3(0.95, 0.85, 0.6),
    Earth:   new BABYLON.Color3(0.2,  0.5,  1.0),
    Mars:    new BABYLON.Color3(0.776, 0.361, 0.227),
    Jupiter: new BABYLON.Color3(0.65, 0.45, 0.25),
    Saturn:  new BABYLON.Color3(0.95, 0.9,  0.7),
    Uranus:  new BABYLON.Color3(0.7,  0.9,  1.0),
    Neptune: new BABYLON.Color3(0.6,  0.7,  1.0),
  };

  planets = [];
  planetOrbitMeshes = [];

  for (const el of PLANET_ELTS) {
    if (el.name === "Earth") continue;

    const baseColor  = planetColors[el.name] ?? new BABYLON.Color3(0.6, 0.7, 0.9);
    drawPlanetOrbit(scene, el, 1200, baseColor);

    const radiusScene = planetRadiusToSceneUnits(PLANET_RADII_KM[el.name]);
    const mesh = BABYLON.MeshBuilder.CreateSphere("pl-" + el.name, { diameter: radiusScene * 2 }, scene);
    const mat  = new BABYLON.StandardMaterial("mat-" + el.name, scene);
    mat.diffuseColor  = baseColor;
    mat.emissiveColor = baseColor.scale(0.15);
    mesh.material = mat;
    mesh.position = getPlanetPosition(simulationTimeJD, el);

    const lbl = addLabel(mesh, el.name, { color: baseColor.toHexString() });
    planets.push({ name: el.name, el, mesh, label: lbl });
  }

  earthEl = PLANET_ELTS.find(p => p.name === "Earth");
  const earthRadiusScene = planetRadiusToSceneUnits(PLANET_RADII_KM.Earth);
  earthMesh = BABYLON.MeshBuilder.CreateSphere("earth", { diameter: earthRadiusScene * 2 }, scene);
  const earthMat = new BABYLON.StandardMaterial("earthMat", scene);
  earthMat.diffuseColor  = planetColors.Earth;
  earthMat.emissiveColor = planetColors.Earth.scale(0.15);
  earthMesh.material = earthMat;
  earthMesh.position = getPlanetPosition(simulationTimeJD, earthEl);

  earthLabel = addLabel(earthMesh, "Earth", { color: planetColors.Earth.toHexString(), offsetX: 18, offsetY: -18 });
  drawPlanetOrbit(scene, earthEl, 1200, planetColors.Earth);

  setPlanetOrbitsVisible(planetOrbitsVisible);
  setPlanetsVisible(planetsVisible);
}

function setPlanetOrbitsVisible(on) {
  planetOrbitsVisible = !!on;

  for (const orbit of planetOrbitMeshes) {
    if (orbit && !orbit.isDisposed()) {
      orbit.setEnabled(planetOrbitsVisible);
    }
  }

  const btn = document.getElementById("togglePlanetOrbitsBtn");
  if (btn) btn.textContent = planetOrbitsVisible ? "Hide Planet Orbits" : "Show Planet Orbits";
}

function togglePlanetOrbitsVisible() {
  setPlanetOrbitsVisible(!planetOrbitsVisible);
}

function setPlanetsVisible(on) {
  planetsVisible = !!on;

  for (const p of planets) {
    if (p.mesh && !p.mesh.isDisposed()) p.mesh.setEnabled(planetsVisible);
    if (p.label) p.label.isVisible = planetsVisible;
  }

  if (earthMesh && !earthMesh.isDisposed()) earthMesh.setEnabled(planetsVisible);
  if (earthLabel) earthLabel.isVisible = planetsVisible;

  const btn = document.getElementById("togglePlanetsBtn");
  if (btn) btn.textContent = planetsVisible ? "Hide Planets" : "Show Planets";
}

function togglePlanetsVisible() {
  setPlanetsVisible(!planetsVisible);
}


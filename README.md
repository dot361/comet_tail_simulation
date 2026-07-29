# Comet Simulator

This repository contains the supplementary software for *A Browser Based Three Dimensional Simulator for Comet Dust Tail Modeling*. It includes the interactive simulator and its integrated data-export tools. Manuscript sources, standalone validation scripts, raw observations and large generated runs are not part of the application source, but may be acquired by contacting the authors.

The simulator is a browser application built with Babylon.js. It uses WebGPU compute for large particle populations when available and falls back to a smaller CPU/WebGL particle system on other devices.

## Run the simulator

Serve the repository with any local web server. For example:

```text
python -m http.server 8000
```

Open `http://localhost:8000` in a WebGPU support browser version. An internet connection is required to load Babylon.js from its CDN. The status badge shows whether WebGPU compute or the CPU fallback is active.

Useful URL options are `?force=webgl`, `?force=cpu`, and `?maxParticles=2000000`.

Choose a comet preset or enter orbital elements manually, then use the timeline to move through Julian dates. Dust production is controlled by the activity law, particle lifetime, emission rate and ejection model. The ejection speed depends on grain β and heliocentric distance, while the β curve controls the sampled grain distribution. Particles can be coloured by β, age, distance from the nucleus or velocity relative to the comet.

Pause the simulation to draw synchrones and syndynes or export their sky coordinates. The observer view supports Earth, custom J2000 positions and approximate viewpoints for different telescopes. The Analysis panel also exports orbit samples, telescope-contour data and CPU or accumulated-GPU density grids.

Keyboard shortcuts include `Space` to pause, `Shift+A`/`Shift+D` to change speed, `U` to apply the paused date, `F` to focus on the comet, `X`/`Y`/`Z` for axis views, `O` for the comet orbit and `G` for the grid.

## Model scope

Comet and dust states are propagated as heliocentric two-body trajectories in metres and seconds, with simulation time expressed as Julian days. Radiation pressure changes the solar gravitational parameter to approximately `(1 - β) GM☉` for each grain. Planet positions use fixed J2000 Keplerian elements.

This is an intentionally simplified physical model. Planetary perturbations, nongravitational comet acceleration and live spacecraft ephemerides are not included. The planet display and telescope presets are therefore suitable for visualization and controlled comparisons, not precision navigation. Use Horizons or SPICE when publication-grade geometry is required.


## Project layout

- `index.html`, `css/` and `src/` contain the browser application.
- `src/data/comets.js` contains the comet presets.
- `external/` contains comparison and viewing helpers.

To add a comet, add its orbital solution and display metadata to `src/data/comets.js`, then add a matching button or call `loadComet()` with its identifier.

## Credits

Created by Miks Balodis, with supervision from Mg. sc. comp. Gints Jasmonts and Prof. Andris Slavinskis. If you use this software or results produced with it, please cite the accompanying article: Miks Balodis, Gints Jasmonts, Ali Arshad, and Andris Slavinskis, “A Browser Based Three Dimensional Simulator for Comet Dust Tail Modeling,” Astronomy and Computing.

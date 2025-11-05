const dziRoot = "img/dzi";
const availableDates = [
  "202508200005",
  "202508210000",
  "202508220000",
  "202508230000"
];

const viewer = OpenSeadragon({
  id: "viewer",
  prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/",
  showNavigationControl: true,
  showZoomControl: true,
  minZoomLevel: 0.8,
  defaultZoomLevel: 1,
  preserveViewport: true,
  visibilityRatio: 1.0,
  blendTime: 0.1,
  maxZoomPixelRatio: 4
});

const label = document.getElementById("label");
let currentIndex = 0;

const slider = document.getElementById("slider");
noUiSlider.create(slider, {
  start: [0],
  step: 1,
  range: { min: 0, max: availableDates.length - 1 },
  tooltips: false
});

function loadDZI(index) {
  const date = availableDates[index];
  const dziUrl = `${dziRoot}/${date}/tiled.dzi`;

  label.textContent = `${date.slice(0,4)}/${date.slice(4,6)}/${date.slice(6,8)} ${date.slice(8,10)}:${date.slice(10,12)}`;
  viewer.open(dziUrl);
  currentIndex = index;
}

slider.noUiSlider.on("update", (values) => {
  const newIndex = parseInt(values[0]);
  if (newIndex !== currentIndex) loadDZI(newIndex);
});

loadDZI(0);
// Única responsabilidad: mostrar/ocultar el splash de arranque.
// No conoce mapa, configuración ni cliente.
const splash = document.getElementById("splash-carga");

export function ocultar() {
  splash?.classList.add("splash--oculto");
}

export function mostrarError() {
  // Sin texto: sustituimos el loader por un icono de advertencia para que
  // el usuario no se quede con una animación infinita ante un fallo.
  if (!splash) return;
  splash.replaceChildren(
    Object.assign(document.createElement("calcite-icon"), {
      icon: "exclamation-mark-triangle",
      scale: "l"
    })
  );
}
/**
 * utils/promesas.js
 *
 * Utilidades genéricas para promesas, sin dependencias del SDK ni de la UI.
 *
 * conTimeout(promesa, ms, descripcion)
 *   Rechaza con TimeoutError si la promesa no se resuelve en ms milisegundos.
 *   Por qué existe: un servicio de terceros que no responde deja la promesa
 *   pendiente hasta que el navegador abre su propio límite (minutos), y si esa
 *   promesa está dentro de un Promise.all bloquea al resto. Con un límite
 *   explícito el fallo es rápido, visible y recuperable (mejora 4, pieza 3).
 *   La promesa original no se cancela (el SDK no ofrece cancelar load()); su
 *   resultado tardío simplemente se ignora.
 */

export class TimeoutError extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "TimeoutError";
  }
}

export function conTimeout(promesa, ms, descripcion = "operación") {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(
      () => rechazar(new TimeoutError(`${descripcion} superó ${ms} ms sin responder`)),
      ms
    );
  });
  // Promise.race engancha un manejador a ambas promesas: si la original
  // rechaza después del límite no genera "unhandled rejection".
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

"""
tools/lib/red.py — peticiones HTTP a servicios de terceros.

Responsabilidad única: pedir una URL y devolver SIEMPRE un resultado
(nunca lanzar), con el tiempo de respuesta y un código de error corto.
Quien llama decide qué significa cada fallo; este módulo solo lo describe.

Por qué un objeto Respuesta y no excepciones: el inspector recorre 117
fuentes y un servicio caído es un dato más de la fila (estado_salud), no
un error del script. Mismo principio que DISPONIBILIDAD en
utils/wfsCapabilitiesParser.js: un fallo de un tercero no debe romper ni
afirmar nada; se registra y se sigue.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path

import requests

TIMEOUT_SEGUNDOS = 15

# Umbral a partir del cual un servicio que sí responde se marca "lento".
UMBRAL_LENTO_MS = 5000

# User-Agent de navegador. Copiado de enriquecer-catalogo.py: algunos
# servicios públicos (confirmado con Catastro, ovc.catastro.meh.es) cortan
# la conexión (ConnectionResetError) a clientes que se identifican como
# scripts. No oculta el origen: solo evita un bloqueo automático que no
# distingue una consulta puntual de GetCapabilities de un scraping masivo.
HEADERS_PETICION = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    "Accept": "application/xml,text/xml,application/json,*/*",
}

# Bundle de CA combinado (certifi + CA intermedia FNMT), generado por
# tools/scratch/fix_certificado_fnmt.py. Hallazgo del 30/08/2026: los
# dominios mapama/miteco usan un certificado FNMT cuya CA intermedia no
# está en el bundle de Mozilla que usa requests. Antes había que exportar
# REQUESTS_CA_BUNDLE a mano en PowerShell; aquí se resuelve en el código
# para que el paso no se olvide y funcione igual en Windows y macOS.
RUTA_BUNDLE_FNMT = Path(__file__).resolve().parent.parent / "scratch" / "cacert_fnmt.pem"


def resolver_ca_bundle(ruta_explicita: str | None = None) -> str | bool:
    """
    Orden de prioridad: argumento --ca-bundle > variable REQUESTS_CA_BUNDLE
    > bundle FNMT del repo > verificación por defecto de requests (True).
    Nunca devuelve False: no se desactiva la verificación SSL.
    """
    if ruta_explicita:
        return ruta_explicita
    if os.environ.get("REQUESTS_CA_BUNDLE"):
        return os.environ["REQUESTS_CA_BUNDLE"]
    if RUTA_BUNDLE_FNMT.exists():
        return str(RUTA_BUNDLE_FNMT)
    return True


@dataclass
class Respuesta:
    """Resultado de una petición. ok=True solo si hubo HTTP 2xx."""
    url: str
    ok: bool
    status: int | None = None
    contenido: bytes = b""
    cabeceras: dict = field(default_factory=dict)
    tiempo_ms: int | None = None
    # error_red: timeout, conexión, SSL. error_servicio: el servidor
    # respondió con un código de error (4xx/5xx).
    error_tipo: str | None = None       # "error_red" | "error_servicio" | None
    error_detalle: str = ""

    @property
    def tipo_contenido(self) -> str:
        return (self.cabeceras.get("Content-Type") or "").lower()


def crear_sesion(ca_bundle: str | bool) -> requests.Session:
    sesion = requests.Session()
    sesion.headers.update(HEADERS_PETICION)
    sesion.verify = ca_bundle
    return sesion


def obtener(sesion: requests.Session, url: str, reintentos: int = 1,
            cabeceras_extra: dict | None = None) -> Respuesta:
    """
    GET con reintento y espera creciente (2 s, 4 s...). Solo se reintentan
    los fallos de red: un HTTP 404 o 500 es una respuesta, no un fallo
    transitorio, y repetirlo solo alarga la inspección.
    """
    ultimo = Respuesta(url=url, ok=False, error_tipo="error_red",
                       error_detalle="sin intentos")
    for intento in range(reintentos + 1):
        inicio = time.monotonic()
        try:
            resp = sesion.get(url, timeout=TIMEOUT_SEGUNDOS,
                              headers=cabeceras_extra or None)
            ms = int((time.monotonic() - inicio) * 1000)
            # resp.headers se conserva tal cual (CaseInsensitiveDict): con
            # dict() se perdía la cabecera de servidores que la envían en
            # minúscula ("content-type", CDN de OpenStreetMap, 05/11/2026).
            r = Respuesta(url=url, ok=resp.ok, status=resp.status_code,
                          contenido=resp.content, cabeceras=resp.headers,
                          tiempo_ms=ms)
            if not resp.ok:
                r.error_tipo = "error_servicio"
                r.error_detalle = f"HTTP {resp.status_code}"
            return r
        except requests.exceptions.SSLError as e:
            # Un fallo SSL no se arregla reintentando: se informa ya.
            return Respuesta(url=url, ok=False, error_tipo="error_red",
                             error_detalle=f"ssl: {_corto(e)}")
        except requests.exceptions.Timeout:
            ultimo = Respuesta(url=url, ok=False, error_tipo="error_red",
                               error_detalle=f"timeout ({TIMEOUT_SEGUNDOS} s)")
        except requests.exceptions.RequestException as e:
            ultimo = Respuesta(url=url, ok=False, error_tipo="error_red",
                               error_detalle=_corto(e))
        if intento < reintentos:
            time.sleep(2 * (intento + 1))
    return ultimo


def _corto(e: Exception, n: int = 120) -> str:
    return str(e).replace("\n", " ")[:n]

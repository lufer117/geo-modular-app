#!/usr/bin/env python3
"""
tools/inspeccionar-fuentes.py — inspector de fuentes del catálogo (M-56, pieza 2a).

QUÉ HACE
  Recorre la hoja `exploracion` del inventario editorial, visita cada
  servicio y escribe lo que detecta en data/catalogo/sugerencias.tsv, una
  fila por id_estable. La persona pega ese TSV en la hoja `sugerencias` y
  las columnas grises de `exploracion` lo leen por id y por nombre de
  columna (M-54).

QUÉ NO HACE
  No escribe en el libro editorial: lo abre en solo lectura. Es el
  principio 5 de DISENO_CATALOGO.md (separación por quién escribe): así el
  script no puede pisar una decisión de la persona ni bloquear el archivo.
  No se fía de los datos técnicos del v1: rederiva todo desde el servicio.

ALCANCE DE LA PIEZA 2a
  protocolo_detectado, servidor, orden_ejes, titulo_oficial, resumen,
  proveedor_detectado, extension_bbox, n_capas, identificable, consultable,
  geojson, licencia_detectada, estado_salud, tiempo_respuesta_ms, https,
  apta_motivo (notas del inspector), fecha_inspeccion y rol_sugerido.
  Las columnas que no escribe (cors, compatible_3857, compatible_3d,
  apta_tecnicamente y el resto de _sugerido) siguen mostrando
  "sin inspeccionar" en el libro hasta las piezas 2b y 2c.

USO
  python tools/inspeccionar-fuentes.py
  python tools/inspeccionar-fuentes.py --inventario data/inventario_fuentes_app_nuevo.xlsx
  python tools/inspeccionar-fuentes.py --solo ign-base-wms,dgc-cartografia-catastral-wms
      (actualiza solo esas filas en el sugerencias.tsv existente)

  El bundle SSL de FNMT (tools/scratch/cacert_fnmt.pem) se usa solo si
  existe; ya no hace falta exportar REQUESTS_CA_BUNDLE.
"""

from __future__ import annotations

import argparse
import datetime
import sys
import threading
import warnings
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

try:
    import openpyxl
    import requests  # noqa: F401  (comprobación temprana de dependencias)
except ImportError as e:
    print(f"❌ Falta una dependencia: {e.name}. Instálala con: pip install openpyxl requests")
    sys.exit(1)

# openpyxl avisa de que perdería las listas desplegables (extensión de
# validación de datos) SI guardara el libro. El inspector abre el libro en
# solo lectura y nunca lo guarda, así que el aviso no aplica: se silencia
# solo ese mensaje, no el resto de avisos.
warnings.filterwarnings("ignore", message="Data Validation extension is not supported",
                        category=UserWarning, module="openpyxl")

from lib import capabilities as caps
from lib import protocolo as proto
from lib import red

RAIZ = Path(__file__).resolve().parent.parent
INVENTARIO_DEFECTO = RAIZ / "data" / "inventario_fuentes_app.xlsx"
SALIDA_DEFECTO = RAIZ / "data" / "catalogo" / "sugerencias.tsv"
HOJA = "exploracion"

# Columnas del TSV, con el nombre EXACTO de las cabeceras de exploracion.
# id_estable va primera (la fórmula de las columnas grises busca la fila en
# sugerencias!A:A); el resto se enlaza por nombre, así que el orden es libre
# y se pueden añadir columnas sin romper el libro.
COLUMNAS = [
    "id_estable",
    # URL que el inspector pidió de verdad (capabilities, feed o tesela de
    # prueba), para abrirla y explorar el servicio a mano. Se deriva de url:
    # no se mantiene en el libro, así que no puede desincronizarse.
    "url_capabilities",
    "protocolo_detectado", "servidor", "orden_ejes",
    "titulo_oficial", "resumen", "proveedor_detectado",
    "extension_bbox", "n_capas",
    "identificable", "consultable", "geojson",
    "licencia_detectada",
    "estado_salud", "tiempo_respuesta_ms", "https",
    "apta_motivo", "fecha_inspeccion",
    "rol_sugerido",
]

PARAMS_CAPABILITIES = {
    "WMS": {"SERVICE": "WMS", "REQUEST": "GetCapabilities"},
    "WMTS": {"SERVICE": "WMTS", "REQUEST": "GetCapabilities"},
    "WFS": {"SERVICE": "WFS", "REQUEST": "GetCapabilities"},
    "WCS": {"SERVICE": "WCS", "REQUEST": "GetCapabilities"},
}


# ── Lectura del inventario (solo lectura) ────────────────────────────────────

def leer_fuentes(ruta: Path) -> list[dict]:
    """
    Lee la hoja por NOMBRE, no por posición (diagnóstico de M-18:
    pd.read_excel leía la primera hoja). Falla rápido si falta la hoja o
    una columna imprescindible, con un mensaje que dice qué corregir.
    """
    if not ruta.exists():
        sys.exit(f"❌ No existe el inventario: {ruta}\n"
                 f"   Usa --inventario <ruta> si el libro tiene otro nombre.")
    libro = openpyxl.load_workbook(ruta, read_only=True, data_only=True)
    if HOJA not in libro.sheetnames:
        sys.exit(f"❌ El libro no tiene la hoja '{HOJA}'. Hojas: {', '.join(libro.sheetnames)}")
    filas = libro[HOJA].iter_rows(values_only=True)
    cabecera = [str(c).strip() if c is not None else "" for c in next(filas)]
    for obligatoria in ("id_estable", "url"):
        if obligatoria not in cabecera:
            sys.exit(f"❌ Falta la columna '{obligatoria}' en la hoja '{HOJA}'.")
    i_id, i_url = cabecera.index("id_estable"), cabecera.index("url")

    fuentes, vistos = [], set()
    for fila in filas:
        id_ = str(fila[i_id] or "").strip()
        if not id_:
            continue
        if id_ in vistos:
            # La columna aviso ya lo marca en el libro; aquí solo se evita
            # inspeccionar dos veces y escribir dos filas con el mismo id.
            print(f"⚠️  id_estable duplicado, se inspecciona una vez: {id_}")
            continue
        vistos.add(id_)
        fuentes.append({"id_estable": id_, "url": str(fila[i_url] or "").strip()})
    libro.close()
    return fuentes


# ── Inspección de una fuente ─────────────────────────────────────────────────

_hilos = threading.local()


def _sesion(ca_bundle) -> "requests.Session":
    # Una sesión por hilo: requests.Session no garantiza ser segura entre hilos.
    if not hasattr(_hilos, "sesion"):
        _hilos.sesion = red.crear_sesion(ca_bundle)
    return _hilos.sesion


def _normalizar_esquema(url: str) -> str:
    # Copiado de enriquecer-catalogo.py: hay URLs del v1 sin "https://".
    return url if url.startswith(("http://", "https://")) else f"https://{url}"


def url_capabilities(url: str, protocolo: str) -> str:
    """
    Añade SERVICE y REQUEST conservando los parámetros propios de la URL
    (algunos servicios los necesitan, p. ej. map= en MapServer). Si la URL
    ya trae SERVICE/REQUEST, se sustituyen para no duplicarlos.
    """
    p = urlparse(url)
    actuales = {k: v[0] for k, v in parse_qs(p.query).items()
                if k.upper() not in ("SERVICE", "REQUEST", "VERSION")}
    actuales.update(PARAMS_CAPABILITIES[protocolo])
    return urlunparse(p._replace(query=urlencode(actuales)))


def url_tesela_prueba(url: str) -> str:
    """Tesela 0/0/0: existe en cualquier esquema XYZ o TMS ({-y})."""
    for var in ("{z}", "{x}", "{y}", "{-y}"):
        url = url.replace(var, "0")
    return url


def fila_vacia(fuente: dict) -> dict:
    fila = {c: "" for c in COLUMNAS}
    fila["id_estable"] = fuente["id_estable"]
    fila["fecha_inspeccion"] = datetime.date.today().isoformat()
    fila["https"] = "si" if fuente["url"].lower().startswith("https://") else "no"
    for c in ("identificable", "consultable", "geojson"):
        fila[c] = "desconocido"
    return fila


def _salud(tiempo_ms: int | None) -> str:
    return "lento" if (tiempo_ms or 0) > red.UMBRAL_LENTO_MS else "ok"


def inspeccionar(fuente: dict, ca_bundle) -> dict:
    """Nunca lanza: cualquier fallo queda descrito en la fila."""
    fila = fila_vacia(fuente)
    try:
        _inspeccionar(fuente, fila, _sesion(ca_bundle))
    except Exception as e:  # red de seguridad: un fallo propio no para el recorrido
        fila["estado_salud"] = "error_servicio"
        fila["apta_motivo"] = f"error_inspector: {type(e).__name__}: {str(e)[:100]}"
    return fila


def _inspeccionar(fuente: dict, fila: dict, sesion) -> None:
    url = fuente["url"]
    motivo = proto.motivo_no_inspeccionable(url)
    if motivo:
        fila["estado_salud"] = "no_inspeccionable"
        fila["apta_motivo"] = motivo
        # La URL puede decir el protocolo aunque no se pueda pedir
        # (p. ej. un XYZ con ?apikey=). Se sugiere; la persona decide.
        fila["protocolo_detectado"] = proto.detectar_por_url(url) or ""
        fila["rol_sugerido"] = proto.rol_sugerido(fila["protocolo_detectado"])
        return

    url = _normalizar_esquema(url)
    fila["https"] = "si" if url.startswith("https://") else "no"

    por_url = proto.detectar_por_url(url)
    if por_url in ("XYZ", "MVT"):
        _inspeccionar_teselas(url, por_url, fila, sesion)
        return
    if por_url == "ATOM":
        resultado = _inspeccionar_xml(sesion, url, fila, esperado="ATOM", origen=url)
        if resultado != "ok":
            # La URL ya dice que es ATOM aunque el feed no se pueda leer.
            fila.update({"protocolo_detectado": "ATOM",
                         "rol_sugerido": proto.rol_sugerido("ATOM"),
                         "estado_salud": resultado.split(":")[0],
                         "apta_motivo": resultado})
        return

    # OGC: se prueba primero el protocolo que sugiere la URL. Se para en
    # cuanto uno responde con su capabilities, o si el host no es alcanzable
    # (probar otro protocolo contra un servidor caído solo alarga la espera).
    errores = []
    for p in proto.pista_ogc_por_url(url, proto.protocolo_del_id(fuente["id_estable"])):
        resultado = _inspeccionar_xml(sesion, url_capabilities(url, p), fila,
                                      esperado=p, origen=url)
        if resultado == "ok":
            return
        errores.append(resultado)
        if resultado.startswith("error_red"):
            break

    # Ningún capabilities OGC: ¿es una API JSON o una página web?
    r = red.obtener(sesion, url, reintentos=0)
    if r.ok and "json" in r.tipo_contenido:
        fila.update({"protocolo_detectado": "API", "estado_salud": _salud(r.tiempo_ms),
                     "tiempo_respuesta_ms": str(r.tiempo_ms),
                     "identificable": "no", "consultable": "no", "geojson": "no",
                     "rol_sugerido": proto.rol_sugerido("API")})
        return
    if r.ok and "html" in r.tipo_contenido:
        errores.append("pagina_web: la URL devuelve HTML, no un servicio")

    fila["estado_salud"] = "error_red" if all(e.startswith("error_red") for e in errores) \
        else "error_servicio"
    # Una ServiceException a SERVICE=X prueba que el servidor habla X aunque
    # esté roto (caso Red Natura 2000): el protocolo se conoce, la salud no.
    con_excepcion = [e for e in errores if "ServiceException" in e]
    if con_excepcion:
        p = con_excepcion[0].split(": ", 1)[1].split()[0]
        fila["protocolo_detectado"] = p
        fila["rol_sugerido"] = proto.rol_sugerido(p)
        fila["apta_motivo"] = con_excepcion[0]
        return
    fila["apta_motivo"] = "protocolo_no_reconocido: " + " | ".join(dict.fromkeys(errores))


def _inspeccionar_xml(sesion, url_peticion: str, fila: dict, esperado: str,
                      origen: str) -> str:
    """
    Pide un XML, comprueba que es del protocolo esperado y rellena la fila.
    Devuelve "ok" o un motivo corto con su tipo (error_red / error_servicio).
    """
    r = red.obtener(sesion, url_peticion)
    # Se guarda la primera URL probada aunque falle (sirve para ver el error
    # en el navegador); si luego otra responde bien, esa la sustituye.
    if not fila["url_capabilities"]:
        fila["url_capabilities"] = url_peticion
    if not r.ok:
        return f"{r.error_tipo}: {esperado} {r.error_detalle}"
    try:
        root = caps.parsear(r.contenido)
    except caps.ExcepcionServicio as e:
        return f"error_servicio: {esperado} ServiceException: {e}"
    except caps.XmlNoValido:
        return f"error_servicio: {esperado} respuesta no XML"

    detectado = proto.detectar_por_raiz(root)
    if detectado != esperado:
        # Ej.: se pidió WFS y el servidor devolvió un WMS_Capabilities.
        return f"error_servicio: {esperado} respondió {detectado or caps.local(root)}"

    fila["url_capabilities"] = url_peticion
    datos = caps.leer(root, detectado)
    nota_bbox = datos.pop("_nota_bbox", "")
    for clave, valor in datos.items():
        fila[clave] = caps.limpiar_texto(valor)
    fila.update({
        "protocolo_detectado": detectado,
        "servidor": caps.servidor(root, r.cabeceras.get("Server", ""), origen),
        "estado_salud": _salud(r.tiempo_ms),
        "tiempo_respuesta_ms": str(r.tiempo_ms),
        "rol_sugerido": proto.rol_sugerido(detectado),
    })
    if nota_bbox:
        fila["apta_motivo"] = nota_bbox
    return "ok"


def _inspeccionar_teselas(url: str, protocolo: str, fila: dict, sesion) -> None:
    """
    XYZ y MVT no tienen capabilities: se pide la tesela 0/0/0 y se mira que
    llegue una imagen (XYZ) o un binario de teselas vectoriales (MVT).
    """
    fila.update({"protocolo_detectado": protocolo,
                 "identificable": "no", "consultable": "no", "geojson": "no",
                 "rol_sugerido": proto.rol_sugerido(protocolo)})
    fila["url_capabilities"] = url_tesela_prueba(url)
    r = red.obtener(sesion, fila["url_capabilities"])
    fila["tiempo_respuesta_ms"] = str(r.tiempo_ms) if r.tiempo_ms is not None else ""
    if not r.ok:
        fila["estado_salud"] = r.error_tipo
        fila["apta_motivo"] = f"tesela 0/0/0: {r.error_detalle}"
        return
    tipo = r.tipo_contenido
    esperado = ("image/",) if protocolo == "XYZ" else ("protobuf", "mvt", "octet-stream")
    if not any(e in tipo for e in esperado):
        fila["estado_salud"] = "error_servicio"
        fila["apta_motivo"] = f"tesela 0/0/0: tipo inesperado ({tipo or 'sin Content-Type'})"
        return
    fila["estado_salud"] = _salud(r.tiempo_ms)
    fila["servidor"] = "desconocido"


# ── Escritura del TSV ────────────────────────────────────────────────────────

def _celda(valor: str) -> str:
    """
    Excel interpreta como fórmula un valor pegado que empieza por = + - @.
    Se antepone un apóstrofo, que Excel trata como marca de texto y no muestra.
    """
    v = (valor or "").replace("\t", " ").replace("\r", " ").replace("\n", " ")
    return "'" + v if v[:1] in ("=", "+", "-", "@") else v


def escribir_tsv(filas: list[dict], ruta: Path) -> None:
    """
    UTF-8 SIN BOM a propósito: con BOM, la primera cabecera llegaría al
    libro como "\\ufeffid_estable" y COINCIDIR no encontraría ninguna fila.
    Sin el módulo csv: no se entrecomilla nada (las comillas de un resumen
    llegarían literales al libro) y _celda ya quita tabuladores y saltos.
    """
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with open(ruta, "w", encoding="utf-8", newline="") as f:
        f.write("\t".join(COLUMNAS) + "\r\n")
        for fila in filas:
            f.write("\t".join(_celda(fila.get(c, "")) for c in COLUMNAS) + "\r\n")


# ── Resumen por consola ──────────────────────────────────────────────────────

def resumen(filas: list[dict]) -> None:
    print("\nEstado de salud:")
    for k, n in Counter(f["estado_salud"] for f in filas).most_common():
        print(f"  {k or '(vacío)':<18} {n}")
    print("Protocolo detectado:")
    for k, n in Counter(f["protocolo_detectado"] for f in filas).most_common():
        print(f"  {k or '(ninguno)':<18} {n}")

    # Mismo control que la columna aviso, adelantado a la consola: el id
    # termina en un protocolo distinto del detectado (posible error del v1).
    distintos = [f for f in filas if f["protocolo_detectado"] and
                 not f["id_estable"].endswith("-" + f["protocolo_detectado"].lower())]
    if distintos:
        print(f"\nEl id no termina en el protocolo detectado ({len(distintos)}):")
        for f in distintos:
            print(f"  {f['id_estable']:<48} → {f['protocolo_detectado']}")

    invertidos = [f["id_estable"] for f in filas if f["orden_ejes"] == "yx"]
    if invertidos:
        print(f"\nWFS con ejes ESRI(LongLat) ({len(invertidos)}): {', '.join(invertidos)}")


# ── Programa principal ───────────────────────────────────────────────────────

def argumentos():
    p = argparse.ArgumentParser(description="Inspecciona las fuentes del inventario y "
                                            "escribe sugerencias.tsv (M-56).")
    p.add_argument("--inventario", type=Path, default=INVENTARIO_DEFECTO,
                   help=f"Libro editorial (por defecto {INVENTARIO_DEFECTO.relative_to(RAIZ)})")
    p.add_argument("--salida", type=Path, default=SALIDA_DEFECTO,
                   help=f"TSV de salida (por defecto {SALIDA_DEFECTO.relative_to(RAIZ)})")
    p.add_argument("--solo", default="",
                   help="Lista de id_estable separados por coma. Solo esas filas se "
                        "reinspeccionan y se actualizan en el TSV existente; el resto se conserva")
    p.add_argument("--concurrencia", type=int, default=6,
                   help="Fuentes inspeccionadas a la vez (por defecto 6)")
    p.add_argument("--ca-bundle", default=None,
                   help="Bundle de CA (por defecto tools/scratch/cacert_fnmt.pem si existe)")
    return p.parse_args()


def leer_tsv_existente(ruta: Path) -> dict[str, dict]:
    """
    Filas del sugerencias.tsv anterior, por id_estable. Las columnas se leen
    por nombre: un TSV de una versión anterior del script (sin alguna
    columna) se conserva y la columna nueva queda vacía en esas filas.
    """
    if not ruta.exists():
        return {}
    with open(ruta, encoding="utf-8") as f:
        lineas = [l.rstrip("\r\n") for l in f if l.strip()]
    if not lineas:
        return {}
    cabecera = lineas[0].split("\t")
    if "id_estable" not in cabecera:
        return {}
    filas = {}
    for linea in lineas[1:]:
        valores = linea.split("\t")
        fila = {c: "" for c in COLUMNAS}
        fila.update({c: v for c, v in zip(cabecera, valores) if c in fila})
        if fila["id_estable"]:
            filas[fila["id_estable"]] = fila
    return filas


def main():
    args = argumentos()
    fuentes = leer_fuentes(args.inventario)
    todas = list(fuentes)
    if args.solo:
        pedidos = {s.strip() for s in args.solo.split(",") if s.strip()}
        desconocidos = pedidos - {f["id_estable"] for f in fuentes}
        if desconocidos:
            print(f"⚠️  No están en el inventario: {', '.join(sorted(desconocidos))}")
        fuentes = [f for f in fuentes if f["id_estable"] in pedidos]

    ca_bundle = red.resolver_ca_bundle(args.ca_bundle)
    print(f"Inventario: {args.inventario}")
    print(f"Bundle SSL: {ca_bundle if ca_bundle is not True else 'el de requests (certifi)'}")
    print(f"Inspeccionando {len(fuentes)} fuentes con {args.concurrencia} a la vez...\n")

    filas = {}
    with ThreadPoolExecutor(max_workers=max(1, args.concurrencia)) as ex:
        futuros = {ex.submit(inspeccionar, f, ca_bundle): f["id_estable"] for f in fuentes}
        for i, fut in enumerate(as_completed(futuros), 1):
            fila = fut.result()
            filas[fila["id_estable"]] = fila
            print(f"  [{i:>3}/{len(fuentes)}] {fila['id_estable']:<48} "
                  f"{fila['protocolo_detectado'] or '—':<6} {fila['estado_salud']}")

    inspeccionadas = [filas[f["id_estable"]] for f in fuentes]

    # Con --solo se ACTUALIZAN esas filas dentro del TSV existente y el resto
    # se conserva tal cual (con su fecha_inspeccion antigua). Antes se
    # reescribía el archivo solo con las fuentes pedidas, y al pegarlo en el
    # libro las demás volvían a "sin inspeccionar".
    if args.solo:
        previas = leer_tsv_existente(args.salida)
        previas.update(filas)
        conservadas = len([f for f in todas if f["id_estable"] in previas]) - len(filas)
        # Ids que ya no están en el inventario se descartan del TSV.
        salida = [previas[f["id_estable"]] for f in todas if f["id_estable"] in previas]
        print(f"\nActualizadas {len(filas)} filas; conservadas {max(conservadas, 0)} "
              f"de la ejecución anterior.")
    else:
        salida = inspeccionadas

    # Se escribe en el orden del inventario, no en el de llegada, para que
    # el TSV sea comparable entre ejecuciones.
    escribir_tsv(salida, args.salida)
    resumen(inspeccionadas)
    print(f"\n✅ {args.salida}\n   Ábrelo en un editor de texto, copia todo y pégalo en la hoja "
          f"'sugerencias' (Ctrl+A, Supr, pegar en A1).")


if __name__ == "__main__":
    main()

"""
tools/lib — módulos compartidos por los scripts del catálogo.

Responsabilidad: todo lo que hable con un servicio externo o interprete su
autodescripción (capabilities), sin saber nada del libro editorial ni del
catálogo final. Lo usan inspeccionar-fuentes.py (M-56) y, más adelante,
generar-catalogo.py (M-57), para que ambos apliquen exactamente las mismas
reglas (DRY): mismo User-Agent, mismo bundle SSL, mismos parsers.

    red.py           → peticiones HTTP: sesión, SSL FNMT, reintentos, tiempos
    protocolo.py     → qué protocolo es una URL o una respuesta
    capabilities.py  → extracción de datos de GetCapabilities y feeds ATOM

Origen: la lógica de red y de parseo se copió de enriquecer-catalogo.py
(04/11/2026). Ese script no se toca mientras siga generando el catálogo
actual; la duplicación desaparece cuando M-57 lo sustituya.
"""

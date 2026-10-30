# NotesPro

App de notas para la universidad, hecha para tablets Android con lápiz óptico.

- Materias con colores y notas por materia
- Escritura con lápiz sensible a la presión; la palma no raya
- Lápiz mágico: convierte trazos en líneas, flechas, círculos, óvalos, triángulos, rectángulos, rombos y polígonos
  (o mantén el lápiz quieto al final de un trazo con el lápiz normal)
- Resaltador, borrador, lazo para seleccionar y mover, texto con teclado
- Insertar imágenes desde la galería o la cámara
- **Importar PDF** (diapositivas, guías) y escribir encima: cada página queda como fondo de una hoja; los títulos de cada página entran al índice y el texto del PDF se puede buscar
- Dos formatos: **hojas** (páginas una debajo de otra) o **lienzo libre** (sin bordes, hacia cualquier lado)
- Fondos rayado, cuadriculado, de puntos o en blanco
- **Ver todo**: en hojas muestra todas las páginas en cuadrícula; en el lienzo aleja la vista hasta que se vea todo lo dibujado
- **Mapa** de la nota en una esquina: muestra dónde estás y lleva a cualquier parte con un toque
- Zoom con pellizco o botones, que permite alejarse hasta ver la nota completa
- **Marcadores**: cintas de color en la hoja; también se puede encerrar un título escrito a mano con el lazo y marcarlo
- **Índice automático** de cada nota (títulos, subtítulos, marcadores e imágenes por página) y de cada materia, nota por nota
- La búsqueda encuentra notas por su título o por los títulos y marcadores que tienen dentro
- Deshacer con dos dedos; todo se guarda en la tablet, sin internet
- **Modo Estudiar**: tapa partes de la nota (o todo lo resaltado) y destápalas con un toque para ponerte a prueba
- **Flashcards** creadas desde la nota (también sobre PDF importados), con repaso por repetición espaciada y acceso directo a la parte de la nota de donde salió cada tarjeta
- **Unir parejas**: juego de relacionar columnas (definición con nombre) contra el reloj, con las tarjetas de una materia o de un tema
- **Escribir tarjetas** rápido: nombre o término y definición, fila por fila
- **Pomodoro**: enfoque y descanso por materia, visible en toda la app y con aviso aunque la pantalla esté apagada
- **Modo examen**: simulacro con tiempo límite y nota de 0 a 5; lo que no sabías queda para repasar hoy
- **Tiempo de estudio**: minutos por día y por materia cada semana, y días seguidos estudiando
- **Copia de seguridad**: un archivo `.notespro` con todas las notas para enviar a Google Drive, correo o WhatsApp;
  copia automática diaria en `Documentos/NotesPro` (últimos 7 días) y restauración que no borra nada
- **Exportar a PDF** una nota o una materia completa (con portada); el índice de la app se vuelve los marcadores del PDF

## Descargar el APK

Cada cambio en `main` compila la app automáticamente. El APK queda en la sección **Releases** del repositorio.

## Estructura

- `www/` — la app (HTML, CSS y JavaScript)
- `android/` — proyecto Android generado con Capacitor
- `.github/workflows/build-apk.yml` — compilación y publicación del APK

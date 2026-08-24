#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(ggplot2)
  library(sf)
  library(ggspatial)
})

args <- commandArgs(trailingOnly = TRUE)

default_city_dir <- "/data/haoxi/MAP_REVIEW/G-maps_crab/CLI_scraper/output/hongkong"
default_assets_dir <- "/data/haoxi/MAP_REVIEW/G-maps_crab/CLI_scraper/data/hongkong"

options <- list(
  city_dir = default_city_dir,
  assets_dir = default_assets_dir,
  places = file.path(default_city_dir, "places.ndjson"),
  removed = file.path(default_city_dir, "places_removed.ndjson"),
  boundary = file.path(default_assets_dir, "hongkong_boundary.geojson"),
  basemap = "cartolight",
  out = file.path(default_city_dir, "hongkong_places_removed_overlay.png"),
  tile_cache = file.path(default_city_dir, ".tile-cache")
)

parse_args <- function(argv, opts) {
  i <- 1
  while (i <= length(argv)) {
    key <- argv[[i]]
    if (!startsWith(key, "--")) {
      stop(sprintf("Unknown argument: %s", key), call. = FALSE)
    }
    if (i == length(argv)) {
      stop(sprintf("Missing value for %s", key), call. = FALSE)
    }
    value <- argv[[i + 1]]
    name <- sub("^--", "", key)
    name <- gsub("-", "_", name)
    if (!name %in% names(opts)) {
      stop(sprintf("Unsupported option: %s", key), call. = FALSE)
    }
    opts[[name]] <- value
    i <- i + 2
  }
  opts
}

options <- parse_args(args, options)

if (!file.exists(options$places)) stop("places file not found: ", options$places, call. = FALSE)
if (!file.exists(options$removed)) stop("removed file not found: ", options$removed, call. = FALSE)
if (!file.exists(options$boundary)) stop("boundary file not found: ", options$boundary, call. = FALSE)

extract_points <- function(path, label, chunk_size = 5000L) {
  con <- file(path, open = "r", encoding = "UTF-8")
  on.exit(close(con), add = TRUE)

  pattern_lat <- '"latitude":(-?[0-9]+(?:\\.[0-9]+)?)'
  pattern_lng <- '"longitude":(-?[0-9]+(?:\\.[0-9]+)?)'
  chunks <- list()
  idx <- 1L

  repeat {
    lines <- readLines(con, n = chunk_size, warn = FALSE)
    if (!length(lines)) break

    lat_match <- regexec(pattern_lat, lines, perl = TRUE)
    lng_match <- regexec(pattern_lng, lines, perl = TRUE)

    lat <- regmatches(lines, lat_match)
    lng <- regmatches(lines, lng_match)

    lat_val <- suppressWarnings(as.numeric(vapply(lat, function(x) if (length(x) >= 2L) x[[2]] else NA_character_, character(1))))
    lng_val <- suppressWarnings(as.numeric(vapply(lng, function(x) if (length(x) >= 2L) x[[2]] else NA_character_, character(1))))

    valid <- is.finite(lat_val) & is.finite(lng_val)
    if (any(valid)) {
      chunks[[idx]] <- data.frame(
        lon = lng_val[valid],
        lat = lat_val[valid],
        dataset = label,
        stringsAsFactors = FALSE
      )
      idx <- idx + 1L
    }
  }

  if (!length(chunks)) {
    return(data.frame(lon = numeric(), lat = numeric(), dataset = character(), stringsAsFactors = FALSE))
  }

  do.call(rbind, chunks)
}

boundary <- st_read(options$boundary, quiet = TRUE)
if (is.na(st_crs(boundary))) {
  boundary <- st_set_crs(boundary, 4326)
}
boundary <- st_transform(boundary, 3857)

bbox <- st_bbox(boundary)
pad_x <- as.numeric((bbox$xmax - bbox$xmin) * 0.05)
pad_y <- as.numeric((bbox$ymax - bbox$ymin) * 0.05)
plot_xlim <- c(bbox$xmin - pad_x, bbox$xmax + pad_x)
plot_ylim <- c(bbox$ymin - pad_y, bbox$ymax + pad_y)

places_df <- extract_points(options$places, "places")
removed_df <- extract_points(options$removed, "removed")
points_df <- rbind(places_df, removed_df)

points_sf <- st_as_sf(points_df, coords = c("lon", "lat"), crs = 4326, remove = FALSE)
points_sf <- st_transform(points_sf, 3857)
coords_3857 <- st_coordinates(points_sf)
in_view <- (
  coords_3857[, "X"] >= plot_xlim[[1]] & coords_3857[, "X"] <= plot_xlim[[2]] &
    coords_3857[, "Y"] >= plot_ylim[[1]] & coords_3857[, "Y"] <= plot_ylim[[2]]
)
points_view <- points_sf[in_view, , drop = FALSE]
counts_total <- aggregate(lon ~ dataset, data = points_df, FUN = length)
counts_view <- aggregate(lon ~ dataset, data = points_view, FUN = length)
names(counts_total)[2] <- "total_n"
names(counts_view)[2] <- "view_n"
counts <- merge(counts_total, counts_view, by = "dataset", all = TRUE)
counts$total_n[is.na(counts$total_n)] <- 0L
counts$view_n[is.na(counts$view_n)] <- 0L

label_for <- function(dataset) {
  row <- counts[counts$dataset == dataset, , drop = FALSE]
  if (!nrow(row)) return(dataset)
  sprintf("%s (%s total, %s shown)", dataset, format(row$total_n, big.mark = ","), format(row$view_n, big.mark = ","))
}

points_view$dataset <- factor(
  points_view$dataset,
  levels = c("removed", "places"),
  labels = c(label_for("removed"), label_for("places"))
)

color_values <- setNames(
  c("#F04E65", "#00B8D9"),
  c(label_for("removed"), label_for("places"))
)

plot_title <- "Hong Kong places vs removed points"
plot_subtitle <- sprintf(
  "Basemap and points are both rendered in EPSG:3857 (Web Mercator); points outside the Hong Kong map window are omitted from the main panel."
)

p <- ggplot() +
  annotation_map_tile(
    type = options$basemap,
    cachedir = options$tile_cache,
    zoomin = 0,
    progress = "none"
  ) +
  geom_sf(
    data = boundary,
    inherit.aes = FALSE,
    fill = NA,
    color = "#FFFFFF",
    linewidth = 0.45,
    alpha = 0.95
  ) +
  geom_point(
    data = subset(points_view, grepl("^removed", dataset)),
    aes(color = dataset, geometry = geometry),
    stat = "sf_coordinates",
    size = 0.7,
    alpha = 0.55
  ) +
  geom_point(
    data = subset(points_view, grepl("^places", dataset)),
    aes(color = dataset, geometry = geometry),
    stat = "sf_coordinates",
    size = 0.55,
    alpha = 0.35
  ) +
  coord_sf(
    crs = st_crs(boundary),
    default_crs = st_crs(boundary),
    xlim = plot_xlim,
    ylim = plot_ylim,
    expand = FALSE
  ) +
  scale_color_manual(
    values = color_values,
    name = NULL
  ) +
  labs(
    title = plot_title,
    subtitle = plot_subtitle,
    x = NULL,
    y = NULL,
    caption = paste(
      "Source:",
      basename(options$places),
      "+",
      basename(options$removed)
    )
  ) +
  theme_minimal(base_size = 12) +
  theme(
    panel.grid = element_blank(),
    panel.background = element_rect(fill = "#EEF3F6", color = NA),
    plot.background = element_rect(fill = "white", color = NA),
    legend.position = c(0.02, 0.05),
    legend.justification = c(0, 0),
    legend.background = element_rect(fill = scales::alpha("white", 0.85), color = "#D0D7DE"),
    plot.title = element_text(face = "bold", size = 16),
    plot.subtitle = element_text(color = "#4B5563"),
    plot.caption = element_text(color = "#6B7280"),
    axis.text = element_blank(),
    axis.ticks = element_blank()
  )

dir.create(dirname(options$out), recursive = TRUE, showWarnings = FALSE)
dir.create(options$tile_cache, recursive = TRUE, showWarnings = FALSE)
ggsave(options$out, p, width = 12, height = 9, dpi = 180, bg = "white")

message("Saved plot to: ", options$out)
message(
  sprintf(
    "Counts | places: %s total / %s shown | removed: %s total / %s shown",
    format(counts$total_n[counts$dataset == "places"], big.mark = ","),
    format(counts$view_n[counts$dataset == "places"], big.mark = ","),
    format(counts$total_n[counts$dataset == "removed"], big.mark = ","),
    format(counts$view_n[counts$dataset == "removed"], big.mark = ",")
  )
)

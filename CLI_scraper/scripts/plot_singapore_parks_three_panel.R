#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(jsonlite)
  library(dplyr)
  library(ggplot2)
})

args <- commandArgs(trailingOnly = TRUE)

options <- list(
  input = "output/singapore_parks/places.ndjson",
  out_dir = "output/singapore_parks/plots",
  plot = "singapore_parks_three_panel.png"
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
    name <- gsub("-", "_", sub("^--", "", key))
    if (!name %in% names(opts)) {
      stop(sprintf("Unsupported option: %s", key), call. = FALSE)
    }
    opts[[name]] <- argv[[i + 1]]
    i <- i + 2
  }
  opts
}

options <- parse_args(args, options)

if (!file.exists(options$input)) {
  stop("Input file not found: ", options$input, call. = FALSE)
}

collapse_values <- function(x) {
  if (is.null(x) || length(x) == 0 || all(is.na(x))) return(NA_character_)
  paste(unlist(x, use.names = FALSE), collapse = "; ")
}

fmt_n <- function(x) format(x, big.mark = ",", scientific = FALSE, trim = TRUE)

input_con <- file(options$input, open = "r", encoding = "UTF-8")
raw <- tryCatch(
  stream_in(input_con, verbose = FALSE, flatten = TRUE),
  finally = close(input_con)
)

places <- raw %>%
  transmute(
    name = .data[["business.name"]],
    mainCategory = .data[["business.mainCategory"]],
    categories = vapply(.data[["business.categories"]], collapse_values, character(1)),
    latitude = as.numeric(.data[["business.latitude"]]),
    longitude = as.numeric(.data[["business.longitude"]]),
    rating = as.numeric(.data[["business.rating"]]),
    reviewCount = as.integer(.data[["business.reviewCount"]]),
    address = vapply(.data[["business.address"]], collapse_values, character(1)),
    fullAddress = .data[["business.fullAddress"]],
    placeId = coalesce(.data[["business.placeId"]], .data[["_meta.placeId"]]),
    sourceUrl = coalesce(.data[["sourceUrl"]], .data[["_meta.sourceUrl"]]),
    neighborhood = .data[["_meta.neighborhood"]],
    extractedAt = .data[["extractedAt"]]
  ) %>%
  mutate(
    mainCategory = if_else(is.na(mainCategory) | mainCategory == "", "Unclassified", mainCategory)
  )

green_nature_categories <- c(
  "Park",
  "Hiking area",
  "Dog park",
  "Garden",
  "Nature preserve",
  "Barbecue area",
  "Promenade",
  "Scenic spot",
  "Ecological park",
  "Memorial park",
  "City park",
  "National forest",
  "Wildlife park"
)

raw_hits <- places
green_nature <- places %>% filter(mainCategory %in% green_nature_categories)
parks_only <- places %>% filter(mainCategory == "Park")

expected_counts <- c(raw_hits = 2136L, green_nature = 631L, parks_only = 472L)
actual_counts <- c(
  raw_hits = nrow(raw_hits),
  green_nature = nrow(green_nature),
  parks_only = nrow(parks_only)
)

if (!identical(unname(actual_counts), unname(expected_counts))) {
  warning(
    "Expected counts differ from observed counts: ",
    paste(names(actual_counts), actual_counts, sep = "=", collapse = ", "),
    call. = FALSE
  )
}

dir.create(options$out_dir, recursive = TRUE, showWarnings = FALSE)

write.csv(
  parks_only,
  file.path(options$out_dir, "parks_only_mainCategory_park_472.csv"),
  row.names = FALSE,
  na = ""
)
write.csv(
  green_nature,
  file.path(options$out_dir, "green_nature_family_631.csv"),
  row.names = FALSE,
  na = ""
)
write.csv(
  raw_hits,
  file.path(options$out_dir, "raw_search_hits_with_noise_2136.csv"),
  row.names = FALSE,
  na = ""
)

panel_levels <- c(
  sprintf("Parks only\nn = %s", fmt_n(nrow(parks_only))),
  sprintf("Green/nature family\nn = %s", fmt_n(nrow(green_nature))),
  sprintf("Raw search hits\nn = %s", fmt_n(nrow(raw_hits)))
)

plot_data <- bind_rows(
  parks_only %>% mutate(panel = panel_levels[[1]], plot_group = "Parks only"),
  green_nature %>% mutate(panel = panel_levels[[2]], plot_group = "Green/nature family"),
  raw_hits %>% mutate(panel = panel_levels[[3]], plot_group = "Raw search hits")
) %>%
  filter(is.finite(latitude), is.finite(longitude)) %>%
  mutate(
    panel = factor(panel, levels = panel_levels),
    plot_group = factor(plot_group, levels = c("Parks only", "Green/nature family", "Raw search hits"))
  )

x_range <- range(plot_data$longitude, na.rm = TRUE)
y_range <- range(plot_data$latitude, na.rm = TRUE)
x_pad <- diff(x_range) * 0.04
y_pad <- diff(y_range) * 0.04

p <- ggplot(plot_data, aes(x = longitude, y = latitude)) +
  geom_point(aes(color = plot_group), size = 1.05, alpha = 0.55, stroke = 0) +
  facet_wrap(~panel, nrow = 1) +
  coord_quickmap(
    xlim = c(x_range[[1]] - x_pad, x_range[[2]] + x_pad),
    ylim = c(y_range[[1]] - y_pad, y_range[[2]] + y_pad),
    expand = FALSE
  ) +
  scale_color_manual(
    values = c(
      "Parks only" = "#176C3A",
      "Green/nature family" = "#46A35F",
      "Raw search hits" = "#6B7280"
    ),
    guide = "none"
  ) +
  labs(
    title = "Singapore Park Search Results",
    subtitle = "Spatial comparison of parks, green/nature categories, and raw search hits",
    x = "Longitude",
    y = "Latitude",
    caption = "Source: output/singapore_parks/places.ndjson"
  ) +
  theme_minimal(base_size = 12) +
  theme(
    panel.grid.minor = element_blank(),
    panel.grid.major = element_line(color = "#E5E7EB", linewidth = 0.25),
    strip.text = element_text(face = "bold", size = 11, lineheight = 1.05),
    plot.title = element_text(face = "bold", size = 18),
    plot.subtitle = element_text(color = "#4B5563"),
    plot.caption = element_text(color = "#6B7280"),
    axis.title = element_text(color = "#374151"),
    axis.text = element_text(color = "#4B5563"),
    plot.background = element_rect(fill = "white", color = NA),
    panel.background = element_rect(fill = "#FAFAF8", color = NA)
  )

plot_path <- file.path(options$out_dir, options$plot)
ggsave(plot_path, p, width = 13.5, height = 5.2, dpi = 300, bg = "white")

message("Saved CSV: ", file.path(options$out_dir, "parks_only_mainCategory_park_472.csv"))
message("Saved CSV: ", file.path(options$out_dir, "green_nature_family_631.csv"))
message("Saved CSV: ", file.path(options$out_dir, "raw_search_hits_with_noise_2136.csv"))
message("Saved plot: ", plot_path)
message(
  "Counts: ",
  paste(names(actual_counts), fmt_n(actual_counts), sep = "=", collapse = ", ")
)

#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(DBI)
  library(ggplot2)
  library(RSQLite)
  library(scales)
})

style_file <- "/Volumes/Data/PDF_tool/research/DRAFT/FINAL_PAPER_REWRITE/06_style/paper_theme.R"
source(style_file)

Sys.setenv(SQLITE_TMPDIR = "/private/tmp", TMPDIR = "/private/tmp")

project_root <- "/Volumes/Data/gmaps-production/CLI_scraper"
output_dir <- file.path(project_root, "docs", "assets")
datasets <- data.frame(
  dataset_id = c("20260421", "20260814", "20260819"),
  dataset = c("2026-04-21", "2026-08-14", "2026-08-19"),
  crawl_period = c(
    "2026-04-21\u20132026-05-04",
    "2026-08-14\u20132026-08-18",
    "2026-08-19\u20132026-08-25"
  ),
  database = c(
    file.path(project_root, "output", "singapore", "2026-04-21", "singapore_reviews.db"),
    file.path(
      project_root,
      "output",
      "singapore",
      "2026-08-14",
      "singapore_reviews_20260814.db"
    ),
    paste0(
      "strix:/data2/shared/haoxi/CLI_scraper/output/singapore/",
      "review_shards_4_20260819/reviews.part-{0..3}.ndjson"
    )
  ),
  collection_mode = c("Newest", "Most relevant", "Newest"),
  reported_completeness = c(0.9858, 0.6526, NA_real_),
  stringsAsFactors = FALSE
)

local_datasets <- datasets[datasets$dataset_id != "20260819", ]
missing_databases <- local_datasets$database[!file.exists(local_datasets$database)]
if (length(missing_databases) > 0) {
  stop("Database not found: ", paste(missing_databases, collapse = ", "))
}

extract_frequency <- function(dataset_id, dataset, database) {
  message("Aggregating ", dataset, ": ", database)
  uri <- paste0("file:", database, "?mode=ro&immutable=1")
  connection <- dbConnect(SQLite(), uri, flags = SQLITE_RO, synchronous = NULL)
  on.exit(dbDisconnect(connection), add = TRUE)
  dbExecute(connection, "PRAGMA query_only = ON")
  dbExecute(connection, "PRAGMA temp_store = FILE")
  dbExecute(connection, "PRAGMA cache_size = -262144")
  frequency <- dbGetQuery(connection, paste(
    "WITH reviewer_counts AS (",
    "  SELECT substr(reviewer_link, instr(reviewer_link, '/contrib/') + 9, 21) AS reviewer_id,",
    "         COUNT(*) AS review_count",
    "  FROM reviews",
    "  WHERE instr(reviewer_link, '/contrib/') > 0",
    "  GROUP BY reviewer_id",
    ")",
    "SELECT review_count, COUNT(*) AS reviewers",
    "FROM reviewer_counts",
    "WHERE reviewer_id GLOB '[0-9]*' AND length(reviewer_id) = 21",
    "GROUP BY review_count",
    "ORDER BY review_count"
  ))
  source_review_rows <- dbGetQuery(
    connection,
    "SELECT COUNT(*) AS n FROM reviews"
  )$n[[1]]
  dbDisconnect(connection)
  on.exit(NULL, add = FALSE)

  frequency$review_count <- as.integer(frequency$review_count)
  frequency$reviewers <- as.numeric(frequency$reviewers)
  frequency$dataset_id <- dataset_id
  frequency$dataset <- dataset
  metadata <- data.frame(
    dataset_id = dataset_id,
    dataset = dataset,
    database = database,
    database_bytes = file.info(database)$size,
    source_review_rows = as.numeric(source_review_rows),
    valid_reviewer_linked_rows = sum(frequency$review_count * frequency$reviewers),
    unique_reviewers = sum(frequency$reviewers),
    stringsAsFactors = FALSE
  )
  list(frequency = frequency, metadata = metadata)
}

results <- lapply(seq_len(nrow(local_datasets)), function(index) {
  extract_frequency(
    local_datasets$dataset_id[[index]],
    local_datasets$dataset[[index]],
    local_datasets$database[[index]]
  )
})
frequency <- do.call(rbind, lapply(results, `[[`, "frequency"))
metadata <- do.call(rbind, lapply(results, `[[`, "metadata"))

partial_frequency_path <- file.path(
  output_dir,
  "reviews_per_reviewer_frequency_20260819.csv"
)
partial_log_path <- file.path(
  output_dir,
  "reviews_per_reviewer_20260819_extract.log"
)
if (!file.exists(partial_frequency_path) || !file.exists(partial_log_path)) {
  stop("Missing strix frequency snapshot or audit log for 2026-08-19")
}
partial_frequency <- read.csv(
  partial_frequency_path,
  header = FALSE,
  col.names = c("review_count", "reviewers")
)
partial_frequency$review_count <- as.integer(partial_frequency$review_count)
partial_frequency$reviewers <- as.numeric(partial_frequency$reviewers)
partial_frequency$dataset_id <- "20260819"
partial_frequency$dataset <- "2026-08-19"
partial_log <- lapply(
  readLines(partial_log_path, warn = FALSE),
  jsonlite::fromJSON
)
partial_total <- partial_log[[which(vapply(
  partial_log,
  function(item) isTRUE(item$total),
  logical(1)
))]]
partial_file_rows <- partial_log[vapply(
  partial_log,
  function(item) !isTRUE(item$total),
  logical(1)
)]
partial_metadata <- data.frame(
  dataset_id = "20260819",
  dataset = "2026-08-19",
  database = datasets$database[datasets$dataset_id == "20260819"],
  database_bytes = sum(vapply(
    partial_file_rows,
    function(item) as.numeric(item$bytes_at_start),
    numeric(1)
  )),
  source_review_rows = as.numeric(partial_total$review_rows),
  valid_reviewer_linked_rows = sum(
    partial_frequency$review_count * partial_frequency$reviewers
  ),
  unique_reviewers = sum(partial_frequency$reviewers),
  sampled_at = partial_total$sampled_at,
  place_records = as.numeric(partial_total$place_records),
  stringsAsFactors = FALSE
)
metadata$sampled_at <- NA_character_
metadata$place_records <- NA_real_
frequency <- rbind(frequency, partial_frequency)
metadata <- rbind(metadata, partial_metadata)
metadata <- merge(metadata, datasets, by = c("dataset_id", "dataset", "database"), sort = FALSE)
metadata <- metadata[match(datasets$dataset_id, metadata$dataset_id), ]
metadata$panel_label <- sprintf(
  "%s | %s reviews | %s reviewers",
  metadata$crawl_period,
  comma(metadata$valid_reviewer_linked_rows, accuracy = 1),
  comma(metadata$unique_reviewers, accuracy = 1)
)

breaks <- c(0, 1, 2, 3, 4, 5, 10, 20, Inf)
bin_labels <- c("1", "2", "3", "4", "5", "6-10", "11-20", "21+")
frequency$review_bin <- cut(
  frequency$review_count,
  breaks = breaks,
  labels = bin_labels,
  right = TRUE,
  ordered_result = TRUE
)
distribution <- aggregate(
  frequency$reviewers,
  by = list(
    dataset_id = frequency$dataset_id,
    dataset = frequency$dataset,
    review_bin = frequency$review_bin
  ),
  FUN = sum
)
names(distribution)[4] <- "reviewers"
distribution$dataset <- factor(distribution$dataset, levels = datasets$dataset)
distribution$review_bin <- factor(distribution$review_bin, levels = bin_labels)
distribution$share <- ave(
  distribution$reviewers,
  distribution$dataset,
  FUN = function(values) values / sum(values)
)
distribution$label <- percent(distribution$share, accuracy = 0.1)
distribution$y_position <- match(distribution$review_bin, rev(bin_labels))
panel_lookup <- setNames(metadata$panel_label, metadata$dataset_id)
distribution$panel_label <- unname(panel_lookup[distribution$dataset_id])
distribution$panel_label <- factor(
  distribution$panel_label,
  levels = metadata$panel_label
)
palette <- c(
  "#159A9C", "#2788A8", "#4F75B5", "#7660B3",
  "#9B4EA4", "#B53D90", "#C42F76", "#CB285F"
)
names(palette) <- bin_labels
distribution$fill <- unname(palette[as.character(distribution$review_bin)])

minimum_share <- min(distribution$share[distribution$share > 0])
x_floor <- 10^(floor(log10(minimum_share)) - 1)
x_breaks <- 10^(seq(ceiling(log10(x_floor)), 0))

distribution_layers <- function() {
  list(
    geom_rect(
      aes(
        xmin = x_floor,
        xmax = share,
        ymin = y_position - 0.28,
        ymax = y_position + 0.28,
        fill = fill
      )
    ),
    geom_text(
      aes(x = share, y = y_position, label = label),
      hjust = -0.12,
      family = FIG_AXIS_FAMILY,
      fontface = "bold",
      size = 3.8,
      colour = FIG_INK
    ),
    scale_fill_identity(),
    scale_y_continuous(
      breaks = rev(seq_along(bin_labels)),
      labels = bin_labels,
      expand = expansion(mult = c(0.05, 0.05))
    ),
    scale_x_log10(
      limits = c(x_floor, 1),
      breaks = x_breaks,
      labels = percent_format(accuracy = 0.1),
      expand = expansion(mult = c(0, 0.08))
    ),
    coord_cartesian(clip = "off"),
    paper_theme(base_size = 13),
    theme(
      plot.title = element_text(
        family = FIG_TITLE_FAMILY,
        face = "bold",
        size = 17,
        hjust = 0,
        margin = margin(b = 7)
      ),
      panel.grid.major.y = element_blank(),
      axis.ticks = element_blank(),
      strip.background = element_blank(),
      strip.text = element_text(
        family = FIG_TITLE_FAMILY,
        face = "bold",
        size = 14,
        hjust = 0
      ),
      plot.margin = margin(5, 30, 5, 5)
    )
  )
}

comparison_plot <- ggplot(distribution) +
  distribution_layers() +
  facet_wrap(vars(panel_label), ncol = 1) +
  labs(
    title = "Reviews per reviewer",
    x = "Share of reviewers (log scale)",
    y = "Observed reviews"
  ) +
  theme(panel.spacing.y = grid::unit(0.8, "lines"))

save_paper_panel(
  comparison_plot,
  "reviews_per_reviewer_comparison",
  output_dir,
  width = 7.2,
  height = 10.4
)

for (dataset_value in datasets$dataset) {
  single_data <- subset(distribution, as.character(dataset) == dataset_value)
  single_title <- metadata$panel_label[metadata$dataset == dataset_value]
  single_plot <- ggplot(single_data) +
    distribution_layers() +
    labs(
      title = single_title,
      x = "Share of reviewers (log scale)",
      y = "Observed reviews"
    )
  save_paper_panel(
    single_plot,
    paste0("reviews_per_reviewer_", gsub("-", "", dataset_value)),
    output_dir,
    width = 7.2,
    height = 4.6
  )
}

baseline_share <- subset(
  distribution,
  dataset_id == "20260421",
  select = c("review_bin", "share")
)
names(baseline_share)[2] <- "baseline_share"
differences <- merge(
  subset(
    distribution,
    dataset_id != "20260421",
    select = c("dataset_id", "dataset", "review_bin", "share")
  ),
  baseline_share,
  by = "review_bin",
  sort = FALSE
)
names(differences)[names(differences) == "share"] <- "target_share"
differences$change_percentage_points <- 100 * (
  differences$target_share - differences$baseline_share
)
differences$review_bin <- factor(differences$review_bin, levels = bin_labels)
differences$dataset <- factor(
  differences$dataset,
  levels = datasets$dataset[datasets$dataset_id != "20260421"]
)
period_lookup <- setNames(datasets$crawl_period, datasets$dataset_id)
baseline_period <- unname(period_lookup[["20260421"]])
differences$crawl_period <- unname(period_lookup[differences$dataset_id])
differences$comparison <- factor(
  paste(differences$crawl_period, "minus", baseline_period),
  levels = paste(
    datasets$crawl_period[datasets$dataset_id != "20260421"],
    "minus",
    baseline_period
  )
)
differences$y_position <- match(differences$review_bin, rev(bin_labels))
differences$direction <- ifelse(
  differences$change_percentage_points >= 0,
  "Higher in August",
  "Higher in April"
)
differences$fill <- ifelse(
  differences$change_percentage_points >= 0,
  "#159A9C",
  "#B53D90"
)
differences$delta_label <- ifelse(
  abs(differences$change_percentage_points) < 0.05,
  sprintf("%+.2f pp", differences$change_percentage_points),
  sprintf("%+.1f pp", differences$change_percentage_points)
)
delta_limit <- max(abs(differences$change_percentage_points)) * 1.22

difference_plot <- ggplot(differences) +
  geom_rect(
    aes(
      xmin = pmin(0, change_percentage_points),
      xmax = pmax(0, change_percentage_points),
      ymin = y_position - 0.28,
      ymax = y_position + 0.28,
      fill = fill
    )
  ) +
  geom_vline(xintercept = 0, colour = FIG_INK, linewidth = 0.35) +
  geom_text(
    aes(
      x = change_percentage_points,
      y = y_position,
      label = delta_label,
      hjust = ifelse(change_percentage_points >= 0, -0.12, 1.12)
    ),
    family = FIG_AXIS_FAMILY,
    fontface = "bold",
    size = 3.8,
    colour = FIG_INK
  ) +
  scale_fill_identity() +
  scale_y_continuous(
    breaks = rev(seq_along(bin_labels)),
    labels = bin_labels,
    expand = expansion(mult = c(0.05, 0.05))
  ) +
  scale_x_continuous(
    limits = c(-delta_limit, delta_limit),
    labels = function(values) sprintf("%+.0f", values),
    expand = expansion(mult = c(0, 0))
  ) +
  labs(
    title = "Change in reviewer distribution",
    x = paste0("Change from ", baseline_period, " (percentage points)"),
    y = "Observed reviews"
  ) +
  facet_wrap(vars(comparison), ncol = 1) +
  coord_cartesian(clip = "off") +
  paper_theme(base_size = 13) +
  theme(
    plot.title = element_text(
      family = FIG_TITLE_FAMILY,
      face = "bold",
      size = 17,
      hjust = 0,
      margin = margin(b = 7)
    ),
    panel.grid.major.y = element_blank(),
    axis.ticks = element_blank(),
    strip.background = element_blank(),
    strip.text = element_text(
      family = FIG_TITLE_FAMILY,
      face = "bold",
      size = 14,
      hjust = 0
    ),
    plot.margin = margin(5, 30, 5, 30)
  )

save_paper_panel(
  difference_plot,
  "reviews_per_reviewer_difference",
  output_dir,
  width = 7.2,
  height = 7.8
)

dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
write.csv(
  metadata,
  file.path(output_dir, "reviews_per_reviewer_comparison_metadata.csv"),
  row.names = FALSE
)
write.csv(
  frequency,
  file.path(output_dir, "reviews_per_reviewer_comparison_frequency.csv"),
  row.names = FALSE
)
write.csv(
  distribution[c("dataset_id", "dataset", "review_bin", "reviewers", "share")],
  file.path(output_dir, "reviews_per_reviewer_comparison_bins.csv"),
  row.names = FALSE
)
write.csv(
  differences[c(
    "dataset_id",
    "dataset",
    "review_bin",
    "baseline_share",
    "target_share",
    "change_percentage_points"
  )],
  file.path(output_dir, "reviews_per_reviewer_difference.csv"),
  row.names = FALSE
)

print(metadata[c(
  "dataset",
  "source_review_rows",
  "valid_reviewer_linked_rows",
  "unique_reviewers",
  "reported_completeness"
)])

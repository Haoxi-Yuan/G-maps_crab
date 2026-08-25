#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(ggplot2)
  library(scales)
})

style_file <- "/Volumes/Data/PDF_tool/research/DRAFT/FINAL_PAPER_REWRITE/06_style/paper_theme.R"
source(style_file)

args <- commandArgs(trailingOnly = TRUE)
input_path <- if (length(args) >= 1) args[[1]] else
  paste0(
    "/Volumes/Data/gmaps-production/CLI_scraper/output/singapore/2026-08-14/",
    "singapore_reviews_20260814.db"
  )
output_dir <- if (length(args) >= 2) args[[2]] else
  "/Volumes/Data/gmaps-production/CLI_scraper/docs/assets"

if (!file.exists(input_path)) {
  stop("Input file not found: ", input_path)
}
if (grepl("\\.(db|sqlite|sqlite3)$", input_path, ignore.case = TRUE)) {
  if (!requireNamespace("DBI", quietly = TRUE) ||
      !requireNamespace("RSQLite", quietly = TRUE)) {
    stop("DBI and RSQLite are required for SQLite input")
  }
  connection <- DBI::dbConnect(RSQLite::SQLite(), input_path)
  on.exit(DBI::dbDisconnect(connection), add = TRUE)
  DBI::dbExecute(connection, "PRAGMA query_only = ON")
  DBI::dbExecute(connection, "PRAGMA temp_store = FILE")
  DBI::dbExecute(connection, "PRAGMA cache_size = -262144")
  frequency <- DBI::dbGetQuery(connection, paste(
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
  source_review_rows <- DBI::dbGetQuery(
    connection,
    "SELECT COUNT(*) AS n FROM reviews"
  )$n[[1]]
  DBI::dbDisconnect(connection)
  on.exit(NULL, add = FALSE)
} else {
  if (Sys.which("jq") == "") {
    stop("jq is required to stream reviewer links from NDJSON input")
  }
  jq_filter <- ".detailedReviews[]? | .reviewer_link // empty"
  jq_command <- sprintf("jq -r %s %s", shQuote(jq_filter), shQuote(input_path))
  connection <- pipe(jq_command, open = "r")
  on.exit(close(connection), add = TRUE)
  reviewer_links <- readLines(connection, warn = FALSE)
  close(connection)
  on.exit(NULL, add = FALSE)
  reviewer_links <- reviewer_links[nzchar(reviewer_links)]
  reviewer_ids <- sub("^.*?/contrib/([0-9]+).*$", "\\1", reviewer_links)
  reviewer_ids[!grepl("^[0-9]+$", reviewer_ids)] <-
    reviewer_links[!grepl("^[0-9]+$", reviewer_ids)]
  reviews_per_reviewer <- as.integer(table(reviewer_ids))
  frequency <- as.data.frame(table(reviews_per_reviewer), stringsAsFactors = FALSE)
  names(frequency) <- c("review_count", "reviewers")
  frequency$review_count <- as.integer(frequency$review_count)
  source_review_rows <- length(reviewer_ids)
}

frequency$review_count <- as.integer(frequency$review_count)
frequency$reviewers <- as.numeric(frequency$reviewers)
valid_review_rows <- sum(frequency$review_count * frequency$reviewers)
unique_reviewers <- sum(frequency$reviewers)

breaks <- c(0, 1, 2, 3, 4, 5, 10, 20, Inf)
bin_labels <- c("1", "2", "3", "4", "5", "6-10", "11-20", "21+")
binned <- cut(
  frequency$review_count,
  breaks = breaks,
  labels = bin_labels,
  right = TRUE,
  ordered_result = TRUE
)
distribution <- aggregate(
  frequency$reviewers,
  by = list(review_bin = binned),
  FUN = sum
)
names(distribution)[2] <- "reviewers"
distribution$review_bin <- factor(distribution$review_bin, levels = bin_labels)
distribution$share <- distribution$reviewers / sum(distribution$reviewers)
distribution$label <- ifelse(
  distribution$share >= 0.01,
  percent(distribution$share, accuracy = 0.1),
  percent(distribution$share, accuracy = 0.01)
)
distribution$fill <- c(
  "#159A9C", "#2788A8", "#4F75B5", "#7660B3",
  "#9B4EA4", "#B53D90", "#C42F76", "#CB285F"
)
distribution$y_position <- rev(seq_len(nrow(distribution)))

plot <- ggplot(distribution) +
  geom_rect(
    aes(
      xmin = 2e-4,
      xmax = share,
      ymin = y_position - 0.28,
      ymax = y_position + 0.28,
      fill = fill
    )
  ) +
  geom_text(
    aes(x = share, y = y_position, label = label),
    hjust = -0.12,
    family = FIG_AXIS_FAMILY,
    fontface = "bold",
    size = 3.8,
    colour = FIG_INK
  ) +
  scale_fill_identity() +
  scale_y_continuous(
    breaks = rev(seq_len(nrow(distribution))),
    labels = bin_labels,
    expand = expansion(mult = c(0.05, 0.05))
  ) +
  scale_x_log10(
    limits = c(2e-4, 1),
    breaks = c(1e-3, 1e-2, 1e-1, 1),
    labels = percent_format(accuracy = 0.1),
    expand = expansion(mult = c(0, 0.08))
  ) +
  labs(
    title = "Reviews per reviewer",
    x = "Share of reviewers (log scale)",
    y = "Observed reviews"
  ) +
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
    plot.margin = margin(5, 30, 5, 5)
  )

dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
write.csv(
  distribution[c("review_bin", "reviewers", "share")],
  file.path(output_dir, "reviews_per_reviewer_bins.csv"),
  row.names = FALSE
)
write.csv(
  frequency,
  file.path(output_dir, "reviews_per_reviewer_frequency.csv"),
  row.names = FALSE
)
save_paper_panel(
  plot = plot,
  stem = "reviews_per_reviewer",
  out_dir = output_dir,
  width = 7.2,
  height = 4.6
)

cat(sprintf(
  paste0(
    "Source review rows: %s\nValid reviewer-linked rows: %s\n",
    "Unique reviewers: %s\nPNG: %s\nPDF: %s\n"
  ),
  format(source_review_rows, big.mark = ",", scientific = FALSE),
  format(valid_review_rows, big.mark = ",", scientific = FALSE),
  format(unique_reviewers, big.mark = ",", scientific = FALSE),
  file.path(output_dir, "reviews_per_reviewer.png"),
  file.path(output_dir, "reviews_per_reviewer.pdf")
))

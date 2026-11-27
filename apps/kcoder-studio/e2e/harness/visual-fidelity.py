#!/usr/bin/env python3
"""Compare equal-size UI captures with RGB SSIM, retaining reproducible evidence."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops


def rgb_ssim(reference, actual):
    """Wang SSIM with a 7x7 uniform window, sample covariance and L=255."""
    if reference.shape != actual.shape or min(reference.shape[:2]) < 7:
        raise ValueError("Captures must have the same dimensions and be at least 7x7")
    a = reference.astype(np.float64)
    b = actual.astype(np.float64)

    def mean_window(value):
        integral = np.pad(value, ((1, 0), (1, 0), (0, 0))).cumsum(0).cumsum(1)
        return (integral[7:, 7:] - integral[:-7, 7:] - integral[7:, :-7] + integral[:-7, :-7]) / 49

    mean_a, mean_b = mean_window(a), mean_window(b)
    variance_a = np.maximum(0, mean_window(a * a) - mean_a * mean_a) * 49 / 48
    variance_b = np.maximum(0, mean_window(b * b) - mean_b * mean_b) * 49 / 48
    covariance = (mean_window(a * b) - mean_a * mean_b) * 49 / 48
    numerator = (2 * mean_a * mean_b + 6.5025) * (2 * covariance + 58.5225)
    denominator = (mean_a * mean_a + mean_b * mean_b + 6.5025) * (variance_a + variance_b + 58.5225)
    return float(np.mean(numerator / denominator))


def compare(reference_path, actual_path, output_path, threshold):
    reference = Image.open(reference_path).convert("RGB")
    actual = Image.open(actual_path).convert("RGB")
    score = rgb_ssim(np.asarray(reference), np.asarray(actual))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    difference = output_path.with_suffix(".difference.png")
    ImageChops.difference(reference, actual).save(difference)
    result = {
        "metric": "RGB SSIM, 7x7 uniform window, sample covariance, L=255",
        "reference": str(reference_path),
        "actual": str(actual_path),
        "referenceSha256": hashlib.sha256(reference_path.read_bytes()).hexdigest(),
        "actualSha256": hashlib.sha256(actual_path.read_bytes()).hexdigest(),
        "width": reference.width,
        "height": reference.height,
        "rgbSsim": score,
        "threshold": threshold,
        "passed": score >= threshold,
        "difference": str(difference),
        "scope": "The supplied unaltered captures; no image alignment, resizing or masking is performed by this comparator.",
    }
    output_path.write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("actual", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.95)
    args = parser.parse_args()
    report = compare(args.reference, args.actual, args.output, args.threshold)
    print(json.dumps(report))
    raise SystemExit(0 if report["passed"] else 1)

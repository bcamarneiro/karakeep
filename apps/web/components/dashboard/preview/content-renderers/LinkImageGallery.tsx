import { useTranslation } from "@/lib/i18n/client";

import { ZBookmark } from "@karakeep/shared/types/bookmarks";
import { getAssetUrl } from "@karakeep/shared/utils/assetUtils";

type LinkImageAsset = ZBookmark["assets"][number];

// Natural sort so "slide-2.jpg" sorts before "slide-10.jpg" (the worker names
// files "slide-01.jpg", "slide-02.jpg", ... but we don't want to rely on
// zero-padding staying stable forever).
function naturalCompare(a: string, b: string): number {
  const chunk = /(\d+)|(\D+)/g;
  const aParts = a.match(chunk) ?? [];
  const bParts = b.match(chunk) ?? [];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const aPart = aParts[i] ?? "";
    const bPart = bParts[i] ?? "";
    const aNum = Number(aPart);
    const bNum = Number(bPart);
    if (
      !Number.isNaN(aNum) &&
      !Number.isNaN(bNum) &&
      aPart !== "" &&
      bPart !== ""
    ) {
      if (aNum !== bNum) return aNum - bNum;
    } else if (aPart !== bPart) {
      return aPart < bPart ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Responsive gallery for a bookmark's `linkImage` assets (e.g. Instagram
 * carousel slides). Used both by the Instagram content renderer (above the
 * embed) and by LinkContentSection's reader view for other links that carry
 * `linkImage` assets.
 */
export default function LinkImageGallery({
  assets,
}: {
  assets: LinkImageAsset[];
}) {
  const { t } = useTranslation();
  const images = [...assets].sort((a, b) =>
    naturalCompare(a.fileName ?? a.id, b.fileName ?? b.id),
  );

  if (images.length === 0) {
    return null;
  }

  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((asset, idx) => {
          const alt = asset.fileName ?? `Image ${idx + 1}`;
          return (
            <a
              key={asset.id}
              href={getAssetUrl(asset.id)}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded-md border bg-muted"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- same-origin API asset route, next/image adds no value here */}
              <img
                src={getAssetUrl(asset.id)}
                alt={alt}
                loading="lazy"
                className="aspect-square h-full w-full object-cover transition-opacity hover:opacity-90"
              />
            </a>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("preview.gallery_image_count", { count: images.length })}
      </p>
    </div>
  );
}

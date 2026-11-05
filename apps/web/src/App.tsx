import { Link, Route, Routes } from "react-router";
import { BuildDetailPage } from "./pages/BuildDetailPage.js";
import { BuildsPage } from "./pages/BuildsPage.js";
import { PackageEditPage } from "./pages/PackageEditPage.js";
import { PackagesPage } from "./pages/PackagesPage.js";
import { PublishedPage } from "./pages/PublishedPage.js";
import { UploadDetailPage } from "./pages/UploadDetailPage.js";
import { UploadsPage } from "./pages/UploadsPage.js";

export function App() {
  return (
    <div className="layout">
      <header>
        <Link to="/" className="brand">
          VR UPM Server
        </Link>
        <nav>
          <Link to="/">Upload</Link>
          <Link to="/packages">Package</Link>
          <Link to="/builds">Build</Link>
          <Link to="/published">公開済み</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<UploadsPage />} />
          <Route path="/uploads/:id" element={<UploadDetailPage />} />
          <Route path="/uploads/:uploadId/packages/new" element={<PackageEditPage />} />
          <Route path="/packages" element={<PackagesPage />} />
          <Route path="/packages/:id" element={<PackageEditPage />} />
          <Route path="/builds" element={<BuildsPage />} />
          <Route path="/builds/:id" element={<BuildDetailPage />} />
          <Route path="/published" element={<PublishedPage />} />
          <Route path="*" element={<p>ページが見つかりません。 <Link to="/">Upload 一覧へ</Link></p>} />
        </Routes>
      </main>
    </div>
  );
}

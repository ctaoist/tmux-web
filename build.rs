use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dist_dir = manifest_dir.join("assets/dist");
    println!("cargo:rerun-if-changed={}", dist_dir.display());

    if !dist_dir.join("index.html").is_file() {
        panic!(
            "frontend assets were not found at {}; run `npm run build` before building tmux-web",
            dist_dir.display()
        );
    }

    let mut files = Vec::new();
    collect_files(&dist_dir, &dist_dir, &mut files)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", dist_dir.display()));
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let mut generated = String::from(
        r#"#[derive(Clone, Copy, Debug)]
pub struct EmbeddedAsset {
    pub path: &'static str,
    pub mime: &'static str,
    pub bytes: &'static [u8],
}

pub static EMBEDDED_ASSETS: &[EmbeddedAsset] = &[
"#,
    );

    for (relative_path, absolute_path) in files {
        println!("cargo:rerun-if-changed={}", absolute_path.display());
        let absolute_path = absolute_path.canonicalize().unwrap_or_else(|err| {
            panic!("failed to canonicalize {}: {err}", absolute_path.display())
        });
        generated.push_str("    EmbeddedAsset {\n");
        generated.push_str(&format!(
            "        path: {},\n",
            string_literal(&relative_path)
        ));
        generated.push_str(&format!(
            "        mime: {},\n",
            string_literal(mime_for(&relative_path))
        ));
        generated.push_str(&format!(
            "        bytes: include_bytes!({}),\n",
            string_literal(&absolute_path.to_string_lossy())
        ));
        generated.push_str("    },\n");
    }

    generated.push_str("];\n");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    fs::write(out_dir.join("embedded_assets.rs"), generated)
        .expect("failed to write embedded asset table");
}

fn collect_files(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files)?;
        } else if path.is_file() {
            let relative_path = path
                .strip_prefix(root)
                .expect("asset path should be below dist")
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            files.push((relative_path, path));
        }
    }
    Ok(())
}

fn mime_for(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
    {
        "css" => "text/css; charset=utf-8",
        "gif" => "image/gif",
        "html" => "text/html; charset=utf-8",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn string_literal(value: &str) -> String {
    format!("{value:?}")
}

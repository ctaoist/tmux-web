include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"));

pub fn get(path: &str) -> Option<&'static EmbeddedAsset> {
    EMBEDDED_ASSETS.iter().find(|asset| asset.path == path)
}
